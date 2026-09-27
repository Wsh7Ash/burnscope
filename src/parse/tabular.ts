import { ParseError } from '../errors.js';
import type { MetricsDocument, Sample, Series, SkippedLine } from '../types.js';

export type TabularFormat = 'csv' | 'json';

export interface TabularOptions {
  readonly strict?: boolean;
}

/**
 * Pre-split counter input. A tabular file already separates good from bad
 * events, so label selectors are not needed (and are ignored).
 */
export interface TabularDocument extends MetricsDocument {
  readonly good: readonly Sample[];
  readonly bad: readonly Sample[];
}

const SYNTHETIC_METRIC = 'burnscope_events';

/**
 * Parse a `timestamp,good,bad` CSV or an equivalent JSON array of
 * `{timestamp, good, bad}` records into two counter series.
 */
export function parseTabular(text: string, format: TabularFormat, options: TabularOptions = {}): TabularDocument {
  const strict = options.strict ?? false;
  const records = format === 'csv' ? parseCsvRecords(text, strict) : parseJsonRecords(text, strict);
  return assemble(records, format, strict);
}

interface Record_ {
  readonly t: number;
  readonly good: number;
  readonly bad: number;
  readonly line: number;
  readonly text: string;
}

function assemble(records: readonly Record_[], format: TabularFormat, strict: boolean): TabularDocument {
  const skipped: SkippedLine[] = [];
  const good: Sample[] = [];
  const bad: Sample[] = [];

  for (const record of records) {
    if (record.good < 0 || record.bad < 0) {
      const reason = 'counter values must be non-negative';
      if (strict) throw new ParseError(`line ${record.line}: ${reason}`, record.line, record.text);
      skipped.push({ line: record.line, reason, text: record.text });
    }
    // Keep whichever half of the row is still valid so one bad cell does not
    // discard the healthy counter reading alongside it.
    if (record.good >= 0) good.push({ t: record.t, v: record.good });
    if (record.bad >= 0) bad.push({ t: record.t, v: record.bad });
  }

  good.sort((a, b) => a.t - b.t);
  bad.sort((a, b) => a.t - b.t);

  const series: Series[] = [
    { name: SYNTHETIC_METRIC, labels: { outcome: 'good' }, samples: good },
    { name: SYNTHETIC_METRIC, labels: { outcome: 'bad' }, samples: bad },
  ];

  const timestamps = [...good, ...bad].map((s) => s.t);
  const firstTimestamp = timestamps.length === 0 ? null : Math.min(...timestamps);
  const lastTimestamp = timestamps.length === 0 ? null : Math.max(...timestamps);

  return {
    series,
    skipped,
    format,
    sampleCount: good.length + bad.length,
    firstTimestamp,
    lastTimestamp,
    good,
    bad,
  };
}

const TIMESTAMP_KEYS = ['timestamp', 'time', 'ts', 't'] as const;
const GOOD_KEYS = ['good', 'ok', 'success', 'successes'] as const;
const BAD_KEYS = ['bad', 'errors', 'error', 'failures', 'failed'] as const;

/** Accepts anything with a `has(key)` probe, i.e. a `Set` or a `Map`. */
function pickKey(available: { has(key: string): boolean }, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (available.has(candidate)) return candidate;
  }
  return undefined;
}

function parseCsvRecords(text: string, strict: boolean): Record_[] {
  const lines = text.split(/\r?\n/);
  const out: Record_[] = [];
  let header: string[] | undefined;
  let timeIndex = -1;
  let goodIndex = -1;
  let badIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const lineNumber = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const fields = splitCsvLine(trimmed);
    if (header === undefined) {
      header = fields.map((f) => f.trim().toLowerCase());
      const available = new Set(header);
      const timeKey = pickKey(available, TIMESTAMP_KEYS);
      const goodKey = pickKey(available, GOOD_KEYS);
      const badKey = pickKey(available, BAD_KEYS);
      if (timeKey === undefined || goodKey === undefined || badKey === undefined) {
        const reason = `CSV header must contain timestamp, good and bad columns (got ${header.join(', ')})`;
        if (strict) throw new ParseError(`line ${lineNumber}: ${reason}`, lineNumber, raw);
        throw new ParseError(reason, lineNumber, raw);
      }
      timeIndex = header.indexOf(timeKey);
      goodIndex = header.indexOf(goodKey);
      badIndex = header.indexOf(badKey);
      continue;
    }

    const fail = (reason: string): void => {
      if (strict) throw new ParseError(`line ${lineNumber}: ${reason}`, lineNumber, raw);
    };
    const t = parseTimestamp(fields[timeIndex]);
    const good = parseCounter(fields[goodIndex]);
    const bad = parseCounter(fields[badIndex]);
    if (t === undefined || good === undefined || bad === undefined) {
      fail('row has an unparseable timestamp or non-numeric counter value');
      continue;
    }
    if (good < 0 || bad < 0) fail('counter values must be non-negative');
    out.push({ t, good, bad, line: lineNumber, text: raw });
  }

  if (header === undefined) throw new ParseError('CSV input contains no header row');
  return out;
}

function parseJsonRecords(text: string, strict: boolean): Record_[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ParseError(`input is not valid JSON: ${(error as Error).message}`, undefined, undefined);
  }

  let rows: unknown[];
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { samples?: unknown }).samples)) {
    rows = (parsed as { samples: unknown[] }).samples;
  } else {
    throw new ParseError('JSON input must be an array of samples or an object with a `samples` array');
  }

  const out: Record_[] = [];
  rows.forEach((row, index) => {
    const lineNumber = index + 1;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      const reason = 'each sample must be an object';
      if (strict) throw new ParseError(`sample ${lineNumber}: ${reason}`);
      return;
    }
    const map = new Map<string, unknown>();
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      map.set(key.toLowerCase(), value);
    }
    const timeKey = pickKey(map, TIMESTAMP_KEYS);
    const goodKey = pickKey(map, GOOD_KEYS);
    const badKey = pickKey(map, BAD_KEYS);
    if (timeKey === undefined || goodKey === undefined || badKey === undefined) {
      throw new ParseError(
        `sample ${lineNumber} must provide timestamp, good and bad fields (got ${[...map.keys()].join(', ')})`,
      );
    }
    const t = parseTimestamp(map.get(timeKey));
    const good = parseCounter(map.get(goodKey));
    const bad = parseCounter(map.get(badKey));
    if (t === undefined || good === undefined || bad === undefined) {
      throw new ParseError(`sample ${lineNumber} has an unparseable timestamp or non-numeric counter value`);
    }
    if (good < 0 || bad < 0) throw new ParseError(`sample ${lineNumber}: counter values must be non-negative`);
    out.push({ t, good, bad, line: lineNumber, text: JSON.stringify(row) });
  });

  return out;
}

/** Split a CSV line, honouring double-quoted fields and `""` escapes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * Parse a timestamp given as epoch seconds, epoch milliseconds or ISO-8601.
 * Values below 1e11 are treated as seconds, which covers every date before
 * year 5138 in seconds and after 1973 in milliseconds.
 */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return parseTimestamp(Number(trimmed));
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) return undefined;
    return parsed;
  }
  return undefined;
}

function parseCounter(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export { SYNTHETIC_METRIC };
