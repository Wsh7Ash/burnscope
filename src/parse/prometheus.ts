import { ParseError } from '../errors.js';
import type { MetricsDocument, Sample, Series, SkippedLine } from '../types.js';

const METRIC_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?[ \t]+(.+)$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const NUMERIC_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export interface ParseOptions {
  /** Throw on the first malformed line instead of collecting it. */
  readonly strict?: boolean;
}

/**
 * Parse Prometheus text exposition format.
 *
 * Accepts `name{labels} value [timestamp_ms]`. `# HELP`, `# TYPE` and `# UNIT`
 * metadata lines are ignored, blank lines are ignored, and malformed or
 * non-finite samples are collected in `skipped` unless `strict` is set.
 */
export function parsePrometheus(text: string, options: ParseOptions = {}): MetricsDocument {
  const strict = options.strict ?? false;
  const buckets = new Map<
    string,
    { name: string; labels: Record<string, string>; samples: Sample[]; lastLine: number }
  >();
  const skipped: SkippedLine[] = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const lineNumber = i + 1;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const fail = (reason: string): void => {
      if (strict) throw new ParseError(`line ${lineNumber}: ${reason}`, lineNumber, raw);
      skipped.push({ line: lineNumber, reason, text: raw });
    };

    const match = METRIC_LINE.exec(line);
    if (!match) {
      fail('line does not match `metric{labels} value [timestamp]`');
      continue;
    }
    const [, name, labelBlock, rest] = match;
    if (name === undefined || rest === undefined) {
      fail('incomplete metric line');
      continue;
    }

    let labels: Record<string, string>;
    try {
      labels = labelBlock === undefined ? {} : parseLabels(labelBlock);
    } catch (error) {
      fail(error instanceof ParseError ? error.message : String(error));
      continue;
    }

    const parts = rest.split(/[ \t]+/);
    const valueText = parts[0];
    const timestampText = parts[1];
    if (valueText === undefined || parts.length > 2) {
      fail('expected a value and at most one timestamp');
      continue;
    }

    const value = parseValue(valueText);
    if (parts.length === 1 && value === undefined) {
      // A lone token that is not a number is neither a value nor a timestamp,
      // so the line as a whole does not match the exposition format.
      fail('line does not match `metric{labels} value [timestamp]`');
      continue;
    }
    if (value === undefined) {
      fail(`unparseable value ${JSON.stringify(valueText)}`);
      continue;
    }
    if (!Number.isFinite(value)) {
      fail(`non-finite value ${JSON.stringify(valueText)}`);
      continue;
    }

    let timestamp: number;
    if (timestampText === undefined) {
      // No explicit timestamp: sample time is unknown, so it is not usable for
      // rate maths. Reject rather than invent a time.
      fail('sample has no timestamp; burnscope requires one to compute rates');
      fail(`unparseable value ${JSON.stringify(timestampText ?? '')}`);
      continue;
    }
    timestamp = Number(timestampText);
    if (!Number.isFinite(timestamp)) {
      fail(`unparseable timestamp ${JSON.stringify(timestampText)}`);
      continue;
    }
    if (timestamp < 0) {
      fail(`negative timestamp ${timestampText}`);
      continue;
    }

    const key = seriesKey(name, labels);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { name, labels, samples: [], lastLine: -1 };
      buckets.set(key, bucket);
    }
    // When two consecutive lines write the same series at the same instant the
    // later one wins, matching how a retried scrape overwrites the earlier
    // write. The same instant from separate regions of the file is kept as
    // recorded: summing its deltas still measures the true increase.
    const previous = bucket.samples[bucket.samples.length - 1];
    if (previous !== undefined && bucket.lastLine === lineNumber - 1 && previous.t === timestamp) {
      bucket.samples[bucket.samples.length - 1] = { t: timestamp, v: value };
    } else {
      bucket.samples.push({ t: timestamp, v: value });
    }
    bucket.lastLine = lineNumber;
  }

  // A document that yielded no samples at all, and whose last line was not
  // terminated, was cut off mid-scrape: surface the first failure instead of
  // silently returning an empty document. Well-formed (newline-terminated)
  // input keeps the lenient contract of collecting skips.
  if (skipped.length > 0 && buckets.size === 0 && !/[\r\n]$/.test(text)) {
    const first = skipped[0];
    if (first !== undefined) {
      throw new ParseError(`line ${first.line}: ${first.reason}`, first.line, first.text);
    }
  }

  const series: Series[] = [];
  let sampleCount = 0;
  let first: number | null = null;
  let last: number | null = null;

  for (const bucket of buckets.values()) {
    bucket.samples.sort((a, b) => a.t - b.t);
    for (const sample of bucket.samples) {
      sampleCount += 1;
      if (first === null || sample.t < first) first = sample.t;
      if (last === null || sample.t > last) last = sample.t;
    }
    series.push({ name: bucket.name, labels: Object.freeze(bucket.labels), samples: bucket.samples });
  }

  series.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return seriesKey(a.name, a.labels) < seriesKey(b.name, b.labels) ? -1 : 1;
  });

  return {
    series,
    skipped,
    format: 'prometheus',
    sampleCount,
    firstTimestamp: first,
    lastTimestamp: last,
  };
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const pairs = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${JSON.stringify(labels[key])}`);
  return pairs.length === 0 ? name : `${name}{${pairs.join(',')}}`;
}

/**
 * Parse the contents of a label block — the text between `{` and `}` —
 * honouring Prometheus escape sequences (`\\`, `\"`, `\n`).
 */
export function parseLabels(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const fail = (reason: string): never => {
    throw new ParseError(`label block: ${reason}`);
  };

  while (i < block.length) {
    const ch = block[i];
    if (ch === ',' || ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }

    let key = '';
    while (i < block.length) {
      const c = block[i];
      if (c === undefined || c === '=' || c === ',' || c === '}' || c === ' ' || c === '\t' || c === '"') break;
      key += c;
      i += 1;
    }
    if (!LABEL_NAME.test(key)) fail(`invalid label name ${JSON.stringify(key)}`);

    while (i < block.length && (block[i] === ' ' || block[i] === '\t')) i += 1;
    if (block[i] !== '=') fail(`expected "=" after label ${JSON.stringify(key)}`);
    i += 1;
    while (i < block.length && (block[i] === ' ' || block[i] === '\t')) i += 1;
    if (block[i] !== '"') fail(`expected a quoted value for label ${JSON.stringify(key)}`);
    i += 1;

    let value = '';
    for (;;) {
      const c = block[i];
      if (c === undefined) fail('unterminated label value');
      if (c === '\\') {
        const next = block[i + 1];
        if (next === '\\') {
          value += '\\';
          i += 2;
        } else if (next === '"') {
          value += '"';
          i += 2;
        } else if (next === 'n') {
          value += '\n';
          i += 2;
        } else {
          fail(`invalid escape sequence \\${next ?? ''}`);
        }
      } else if (c === '"') {
        i += 1;
        break;
      } else {
        value += c;
        i += 1;
      }
    }

    if (Object.prototype.hasOwnProperty.call(out, key)) fail(`duplicate label ${JSON.stringify(key)}`);
    out[key] = value;
  }

  return out;
}

function parseValue(raw: string): number | undefined {
  if (raw === 'NaN' || raw === 'nan') return Number.NaN;
  if (raw === '+Inf' || raw === 'Inf' || raw === '+inf' || raw === 'inf') return Number.POSITIVE_INFINITY;
  if (raw === '-Inf' || raw === '-inf') return Number.NEGATIVE_INFINITY;
  if (raw === '') return undefined;
  const value = Number(raw);
  if (Number.isNaN(value)) {
    // Distinguish "not a number at all" from a legitimate NaN literal.
    return NUMERIC_LITERAL.test(raw) ? value : undefined;
  }
  return value;
}
