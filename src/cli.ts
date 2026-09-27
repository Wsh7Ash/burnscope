#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { BurnscopeError, UsageError } from './errors.js';
import { formatPercent, formatWindow } from './format.js';
import { expectedConsumed, getProfile } from './mwmb.js';
import { parsePrometheus } from './parse/prometheus.js';
import { parseTabular, type TabularDocument } from './parse/tabular.js';
import { renderHtml } from './report/html.js';
import { renderJson } from './report/json.js';
import { renderMarkdown } from './report/markdown.js';
import { renderText } from './report/text.js';
import { analyze } from './scope.js';
import { parseSpec } from './spec.js';
import type { MetricsDocument } from './types.js';
import { VERSION } from './version.js';

const USAGE = `burnscope ${VERSION} — SLO burn-rate and error-budget explorer

Usage
  burnscope analyze --slo <spec.json> --input <metrics> [options]
  burnscope parse --input <metrics> [--input-format prom|csv|json]
  burnscope rules [--profile <id>]
  burnscope explain
  burnscope --version | --help

Commands
  analyze   Score SLOs against metrics and report burn rate, budget and alerts.
  parse     Summarise a metrics file: series, samples, time range, skipped lines.
  rules     Print the multi-window multi-burn-rate alert rules.
  explain   Print the error-budget arithmetic and the reasoning behind the rules.

Options for analyze
  --slo <file>            SLO spec file (JSON). Required.
  -i, --input <file>      Metrics file. Required.
  --input-format <fmt>    prom | csv | json. Inferred from the file extension.
  --as-of <when>          Analysis instant: ISO-8601 or epoch seconds/ms.
                          Defaults to the newest sample in the input.
  --profile <id>          Alert rule set. Default: google-sre.
  --min-coverage <0-1>    Minimum share of a window that must be covered before
                          its rate is trusted. Default: 0.5.
  -f, --format <fmt>      text | markdown | json | html. Default: text.
  -o, --out <file>        Write the report to a file instead of stdout.
  --strict                Fail on the first malformed input line.
  --fail-on-firing        Exit 3 if any alert rule is firing.
  --fail-on-exhausted     Exit 3 if any SLO budget is exhausted.

Options for parse
  -i, --input <file>      Metrics file. Required.
  --input-format <fmt>    prom | csv | json. Inferred from the file extension.
  --strict                Fail on the first malformed input line.

Exit codes
  0 success   1 usage error   2 input/spec error   3 a --fail-on-* gate tripped
`;

interface Options {
  slo?: string;
  input?: string;
  'input-format'?: string;
  'as-of'?: string;
  format?: string;
  out?: string;
  'min-coverage'?: string;
  profile?: string;
  strict?: boolean;
  'fail-on-firing'?: boolean;
  'fail-on-exhausted'?: boolean;
  help?: boolean;
  version?: boolean;
}

function main(argv: readonly string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        slo: { type: 'string' },
        input: { type: 'string', short: 'i' },
        'input-format': { type: 'string' },
        'as-of': { type: 'string' },
        format: { type: 'string', short: 'f' },
        out: { type: 'string', short: 'o' },
        'min-coverage': { type: 'string' },
        profile: { type: 'string' },
        strict: { type: 'boolean' },
        'fail-on-firing': { type: 'boolean' },
        'fail-on-exhausted': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (error) {
    process.stderr.write(`burnscope: ${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }

  const options = parsed.values as Options;
  const command = parsed.positionals[0] ?? 'analyze';

  if (options.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (options.help === true || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    switch (command) {
      case 'analyze':
      case 'analyse':
        return runAnalyze(options);
      case 'parse':
        return runParse(options);
      case 'rules':
        return runRules(options);
      case 'explain':
        process.stdout.write(renderExplain());
        return 0;
      default:
        throw new UsageError(`unknown command ${JSON.stringify(command)}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`burnscope: ${error.message}\n\n${USAGE}`);
      return 1;
    }
    if (error instanceof BurnscopeError) {
      process.stderr.write(`burnscope: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

function runAnalyze(options: Options): number {
  if (options.slo === undefined) throw new UsageError('analyze requires --slo <spec.json>');
  if (options.input === undefined) throw new UsageError('analyze requires --input <metrics>');

  const spec = parseSpec(readFileSync(resolve(options.slo), 'utf8'));
  const document = loadMetrics(options.input, options['input-format'], options.strict === true);
  const profile = getProfile(options.profile ?? spec.profileId);
  const minCoverage = parseMinCoverage(options['min-coverage']);

  const asOf = options['as-of'] === undefined ? undefined : parseInstant(options['as-of'], '--as-of');
  const analysis = analyze({
    slos: spec.slos,
    document,
    ...(asOf === undefined ? {} : { asOf }),
    ...(minCoverage === undefined ? {} : { minCoverage }),
    profile,
  });

  const format = (options.format ?? 'text').toLowerCase();
  const body = render(analysis, format);
  emit(body, options.out);

  if (options['fail-on-firing'] === true && analysis.slos.some((slo) => slo.firing.length > 0)) {
    process.stderr.write('burnscope: alert rules are firing\n');
    return 3;
  }
  if (options['fail-on-exhausted'] === true && analysis.slos.some((slo) => slo.budget.state === 'exhausted')) {
    process.stderr.write('burnscope: an error budget is exhausted\n');
    return 3;
  }
  return 0;
}

function render(analysis: Parameters<typeof renderText>[0], format: string): string {
  switch (format) {
    case 'text':
    case 'txt':
      return renderText(analysis);
    case 'markdown':
    case 'md':
      return renderMarkdown(analysis);
    case 'json':
      return renderJson(analysis);
    case 'html':
      return renderHtml(analysis);
    default:
      throw new UsageError(`unknown report format ${JSON.stringify(format)}`);
  }
}

function runParse(options: Options): number {
  if (options.input === undefined) throw new UsageError('parse requires --input <metrics>');
  const document = loadMetrics(options.input, options['input-format'], options.strict === true);

  const lines: string[] = [];
  lines.push(`file        ${options.input}`);
  lines.push(`format      ${document.format}`);
  lines.push(`series      ${document.series.length}`);
  lines.push(`samples     ${document.sampleCount}`);
  lines.push(`from        ${document.firstTimestamp === null ? 'n/a' : new Date(document.firstTimestamp).toISOString()}`);
  lines.push(`to          ${document.lastTimestamp === null ? 'n/a' : new Date(document.lastTimestamp).toISOString()}`);
  if (document.skipped.length > 0) {
    lines.push(`skipped     ${document.skipped.length} line(s)`);
    const reasons = new Map<string, number>();
    for (const skip of document.skipped) reasons.set(skip.reason, (reasons.get(skip.reason) ?? 0) + 1);
    for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${String(count).padStart(5)}  ${reason}`);
    }
  }
  lines.push('');
  lines.push('series');
  for (const series of document.series.slice(0, 40)) {
    const labels = Object.entries(series.labels)
      .map(([key, value]) => `${key}="${value}"`)
      .join(',');
    lines.push(
      `  ${series.name}{${labels}}  ${series.samples.length} samples  ` +
        `from ${new Date(series.samples[0]?.t ?? 0).toISOString()} ` +
        `to ${new Date(series.samples[series.samples.length - 1]?.t ?? 0).toISOString()}`,
    );
  }
  if (document.series.length > 40) lines.push(`  ... and ${document.series.length - 40} more`);

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function runRules(options: Options): number {
  const profile = getProfile(options.profile);
  const format = (options.format ?? 'text').toLowerCase();
  if (format === 'json') {
    process.stdout.write(renderJson({ asOf: 0, profile, slos: [], skipped: [], dataQuality: [], minCoverage: 0 }));
    return 0;
  }

  const lines: string[] = [];
  lines.push(`${profile.name} (${profile.id})`);
  lines.push(profile.description);
  lines.push(`Reference period: ${formatWindow(profile.periodSeconds)}`);
  lines.push('');
  lines.push('A rule fires only when BOTH its long and its short window reach the burn-rate threshold.');
  lines.push('');
  for (const rule of profile.rules) {
    lines.push(`${rule.id}  [${rule.severity}]`);
    lines.push(`  long window   ${formatWindow(rule.longWindowSeconds)}  (threshold ${rule.burnRate}x)`);
    lines.push(`  short window  ${formatWindow(rule.shortWindowSeconds)}  (must also reach ${rule.burnRate}x)`);
    lines.push(`  budget used   ${formatPercent(rule.publishedConsumed)} of the 30d budget by the end of the long window`);
    lines.push(
      `  for a ${formatWindow(profile.periodSeconds)} period this rule is designed to burn ` +
        `${formatPercent(expectedConsumed(rule, profile.periodSeconds))}`,
    );
    lines.push(`  action        ${rule.action}`);
    lines.push('');
  }
  process.stdout.write(`${lines.join('\n').trimEnd()}\n`);
  return 0;
}

function renderExplain(): string {
  return `burnscope ${VERSION} — how the numbers are produced

Error budget
  A 99.9% objective allows 0.1% of events to fail. That 0.1% is the budget ratio.

Burn rate
  burn rate = (failed events / total events) / budget ratio

  1.0x   exactly sustainable: the budget lasts the whole window
  2.0x   twice too fast: the window's budget is gone in half the time
  14.4x  the fast-burn page threshold; a 30-day budget goes in about 2 hours

Budget consumed by a window
  consumed = burn rate * (window length / SLO period)

  The long window of the fast-burn rule is 1h in a 30d period, so at 14.4x
  consumed = 14.4 * (1h / 720h) = 2% — the figure in the published table.

Budget used so far, and the runway
  elapsed fraction = time since the SLO window started / SLO period length
  used             = burn rate * elapsed fraction
  remaining        = 1 - used
  exhaustion       = the moment used reaches 1, i.e. 1 / burn rate of the way
                     through the window; the runway is what is left of that

  A fixed window that started 10 days into a 30-day period and is burning at
  4x has used 4 * (10/30) = 133% of its budget, so it is already exhausted and
  no projection is needed.

Multi-window, multi-burn-rate alerting
  A single window cannot tell a sustained regression from a blip. Each rule
  therefore pairs a long window (sensitivity to a real regression) with a
  short window (evidence that the problem has not already healed). Both must
  reach the same threshold for the rule to fire.

  The four rules in the google-sre profile come from the Google SRE Workbook,
  chapter 5, Table 4. Their thresholds are fixed multiples of the sustainable
  rate, chosen so that each rule fires when a specific amount of budget has
  been lost: 2% in an hour, 5% in six hours, 10% in a day, 10% in three days.

Data quality
  A rate is only reported when at least --min-coverage of the window is
  actually covered by samples, because a short observed span makes the
  increase unstable. Counter resets are handled the way Prometheus handles
  them: a decrease is read as the counter restarting from zero, and the
  post-reset value becomes the increase. No extrapolation to the window edges
  is performed; observedSeconds and coverage are reported instead.
`;
}

function loadMetrics(path: string, formatHint: string | undefined, strict: boolean): MetricsDocument | TabularDocument {
  const text = readFileSync(resolve(path), 'utf8');
  const format = (formatHint ?? inferFormat(path)).toLowerCase();
  switch (format) {
    case 'prom':
    case 'prometheus':
    case 'txt':
      return parsePrometheus(text, { strict });
    case 'csv':
      return parseTabular(text, 'csv', { strict });
    case 'json':
      return parseTabular(text, 'json', { strict });
    default:
      throw new UsageError(`unknown input format ${JSON.stringify(format)}; expected prom, csv or json`);
  }
}

function inferFormat(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.csv':
      return 'csv';
    case '.json':
      return 'json';
    default:
      return 'prom';
  }
}

function parseMinCoverage(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new UsageError(`--min-coverage must be a number in (0, 1], got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseInstant(raw: string, flag: string): number {
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw.trim())) {
    const value = Number(raw);
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new UsageError(`${flag} ${JSON.stringify(raw)} is not an ISO-8601 timestamp or epoch value`);
  }
  return parsed;
}

function emit(body: string, out: string | undefined): void {
  if (out === undefined) {
    process.stdout.write(body);
    return;
  }
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body, 'utf8');
  process.stderr.write(`burnscope: wrote ${target}\n`);
}

process.exit(main(process.argv.slice(2)));
