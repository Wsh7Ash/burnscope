/**
 * burnscope demo — builds a deterministic incident scenario in memory and runs
 * the whole pipeline: spec loader -> Prometheus parser -> analysis -> every
 * report renderer. Run with `--quick` for the small CI scenario.
 *
 * The demo asserts its own results, so a silent regression in budget maths,
 * alerting or rendering fails the run with a non-zero exit code.
 */
import assert from 'node:assert/strict';

import { renderHtml } from '../src/report/html.js';
import { renderJson } from '../src/report/json.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderText } from '../src/report/text.js';
import { parsePrometheus } from '../src/parse/prometheus.js';
import { analyze } from '../src/scope.js';
import { parseSpec } from '../src/spec.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Fixed epoch so the demo prints identical output on every machine. */
const T0 = Date.UTC(2026, 0, 1);

const BUDGET_RATIO = 0.001;
const INTERVAL_EVENTS = 1_000_000;
const STEP_MS = 5 * MINUTE;

interface BurnStep {
  /** Epoch ms at which this interval ends. */
  readonly t: number;
  /** Burn rate held over the interval leading up to `t`. */
  readonly burn: number;
}

/** A schedule holding one burn rate from `from` to `to` in `stepMs` slices. */
function steady(from: number, to: number, stepMs: number, burn: number): BurnStep[] {
  const out: BurnStep[] = [];
  for (let t = from + stepMs; t <= to; t += stepMs) out.push({ t, burn });
  return out;
}

/** Concatenate schedules, dropping any step that is not strictly later. */
function sequence(...parts: readonly BurnStep[][]): BurnStep[] {
  const out: BurnStep[] = [];
  for (const part of parts) {
    for (const step of part) {
      if (out.length === 0 || step.t > (out[out.length - 1]?.t ?? 0)) out.push(step);
    }
  }
  return out;
}

/** Render a burn schedule as Prometheus text exposition, counters included. */
function promFrom(schedule: readonly BurnStep[]): string {
  const lines = ['# HELP requests_total Total requests', '# TYPE requests_total counter'];
  const first = schedule[0];
  if (first === undefined) return `${lines.join('\n')}\n`;
  const stepMs = (schedule[1]?.t ?? first.t + MINUTE) - first.t;
  // Real counters carry a zero reading one step before the first interval.
  lines.push(`requests_total{code="200",job="demo"} 0 ${first.t - stepMs}`);
  lines.push(`requests_total{code="500",job="demo"} 0 ${first.t - stepMs}`);
  let goodTotal = 0;
  let badTotal = 0;
  for (const step of schedule) {
    const failures = Math.min(INTERVAL_EVENTS, Math.round(step.burn * BUDGET_RATIO * INTERVAL_EVENTS));
    badTotal += failures;
    goodTotal += INTERVAL_EVENTS - failures;
    lines.push(`requests_total{code="200",job="demo"} ${goodTotal} ${step.t}`);
    lines.push(`requests_total{code="500",job="demo"} ${badTotal} ${step.t}`);
  }
  return `${lines.join('\n')}\n`;
}

const SPEC_JSON = JSON.stringify({
  slos: [
    {
      name: 'checkout',
      description: 'Checkout API availability.',
      objective: 0.999,
      period: '30d',
      periodStart: '2026-01-01T00:00:00Z',
      metric: 'requests_total',
      good: { matchers: { code: '=~2..' } },
      bad: { matchers: { code: '=~5..' } },
    },
  ],
});

/**
 * Ten days running 1.5x over budget, ending in a fresh 45-minute outage at
 * 20x: the budget is burning, a page is warranted, and the month still has
 * room left. The quick scenario is a quiet 12-hour window at 2x instead.
 */
function scenario(quick: boolean): string {
  const schedule = quick
    ? steady(T0, T0 + 12 * HOUR, 15 * MINUTE, 2)
    : sequence(
        steady(T0, T0 + 10 * DAY - 45 * MINUTE, STEP_MS, 1.5),
        steady(T0 + 10 * DAY - 45 * MINUTE, T0 + 10 * DAY, STEP_MS, 20),
      );
  return promFrom(schedule);
}

function main(): void {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const unknown = args.filter((arg) => arg !== '--quick');
  if (unknown.length > 0) {
    process.stderr.write(`demo: unknown argument ${JSON.stringify(unknown[0])}; usage: demo [--quick]\n`);
    process.exit(1);
  }

  const spec = parseSpec(SPEC_JSON);
  const document = parsePrometheus(scenario(quick));
  assert.equal(document.skipped.length, 0, 'the generated scenario must parse cleanly');
  assert.ok(document.series.length >= 2, 'the scenario needs good and bad series');

  const analysis = analyze({ slos: spec.slos, document });
  const slo = analysis.slos[0];
  assert.ok(slo !== undefined, 'the spec declares one SLO');
  assert.equal(slo.period.sufficient, true, 'ten days of five-minute samples cover the elapsed window');
  assert.equal(slo.goodSeriesCount, 1);
  assert.equal(slo.badSeriesCount, 1);

  const text = renderText(analysis);
  process.stdout.write(text);

  if (quick) {
    assert.equal(slo.budget.state, 'burning', '2x for half a day is over the sustainable rate');
    assert.equal(slo.firing.length, 0, 'a 2x burn clears every alert threshold');
    assert.ok(slo.alerts.some((alert) => !alert.evaluated), 'the 3d window cannot be scored from 12h of data');
    assert.ok(text.includes('checkout'), 'the report names the SLO');
    process.stdout.write('\ndemo (quick): ok\n');
    return;
  }

  assert.equal(slo.budget.state, 'burning');
  assert.ok(slo.firing.some((alert) => alert.rule.id === 'fast-burn-page'), 'the fresh incident must page');
  assert.equal(slo.budget.exhaustsInSeconds !== null, true, 'a 1.5x burn projects an exhaustion instant');

  const markdown = renderMarkdown(analysis);
  const json = renderJson(analysis);
  const html = renderHtml(analysis);
  const roundTripped = JSON.parse(json) as typeof analysis;
  assert.equal(roundTripped.slos.length, 1, 'the JSON report round-trips the analysis');
  assert.match(markdown, /^# Burnscope report$/m);
  assert.match(html, /^<!doctype html>/);
  assert.equal(/<(script|link|img|iframe)\b/i.test(html), false, 'the HTML report is self-contained');

  process.stdout.write(
    [
      '',
      `state:       ${slo.budget.state} — ${Math.round(slo.budget.consumed * 100)}% of the budget consumed`,
      `alerts:      ${slo.firing.length > 0 ? slo.firing.map((alert) => alert.rule.id).join(', ') : 'none firing'}`,
      `report size: text ${text.length} B, markdown ${markdown.length} B, json ${json.length} B, html ${html.length} B`,
      'demo: ok',
      '',
    ].join('\n'),
  );
}

main();
