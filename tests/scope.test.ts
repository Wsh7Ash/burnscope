import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parsePrometheus } from '../src/parse/prometheus.js';
import { parseTabular } from '../src/parse/tabular.js';
import { analyze } from '../src/scope.js';
import type { SloSpec } from '../src/types.js';
import { DAY, HOUR, MINUTE, T0, closeTo, counters, csvFrom, promFrom, sequence, steady } from './_helpers.js';

const BUDGET_RATIO = 0.001;
const TEN_DAYS = 10 * DAY;
const STEP = 5 * MINUTE;

/**
 * The SLO window opened at `T0` and the metrics start there too, so the period
 * measurement is fully covered and can be scored.
 */
const SLO: SloSpec = {
  name: 'checkout',
  objective: 0.999,
  periodSeconds: 30 * DAY / 1000,
  periodStart: T0,
};
const SLO_WITH_SELECTORS: SloSpec = {
  name: 'checkout',
  objective: 0.999,
  periodSeconds: 30 * DAY / 1000,
  periodStart: T0,
  metric: 'requests_total',
  good: { matchers: { code: '=~2..' } },
  bad: { matchers: { code: '=~5..' } },
};

function analyzeCsv(schedule: Parameters<typeof counters>[0], overrides: Partial<Parameters<typeof analyze>[0]> = {}) {
  const document = parseTabular(csvFrom(schedule, BUDGET_RATIO), 'csv');
  return analyze({ slos: [SLO], document, ...overrides });
}

describe('analyze over tabular input', () => {
  it('scores a healthy service and fires nothing', () => {
    const analysis = analyzeCsv(steady(T0, T0 + TEN_DAYS, STEP, 0.5));
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    assert.equal(slo.budget.state, 'healthy');
    assert.equal(slo.firing.length, 0);
    closeTo(slo.period.burnRate, 0.5, 1e-4);
    // 0.5x for a third of a 30-day window: 16.67% of the budget.
    closeTo(slo.budget.consumed, 0.5 / 3, 1e-4);
    assert.ok(slo.budget.remaining > 0.83);
  });

  it('pages on a fresh incident even though the budget is still healthy', () => {
    const schedule = sequence(
      steady(T0, T0 + TEN_DAYS - HOUR, STEP, 0.5),
      steady(T0 + TEN_DAYS - HOUR, T0 + TEN_DAYS, STEP, 20),
    );
    const analysis = analyzeCsv(schedule);
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    assert.equal(slo.budget.state, 'healthy', 'the month-to-date picture is still fine');
    const firing = slo.firing.map((alert) => alert.rule.id);
    assert.deepEqual(firing, ['fast-burn-page'], 'only the hour-scale rule can see one bad hour');
    assert.equal(slo.budget.state, 'healthy', 'the month-to-date picture is still fine');
  });

  it('exhausts the budget and reports the slow rules, not the fast ones', () => {
    const analysis = analyzeCsv(steady(T0, T0 + TEN_DAYS, STEP, 4));
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    assert.equal(slo.budget.state, 'exhausted');
    assert.equal(slo.budget.remaining, 0);
    // 4 * 10/30 = 133% of the budget.
    closeTo(slo.budget.consumed, 4 / 3, 1e-4);
    assert.equal(slo.budget.exhaustsInSeconds, 0);
    assert.deepEqual(slo.firing.map((alert) => alert.rule.id).sort(), ['long-burn-ticket', 'slow-burn-ticket']);
  });

  it('projects the exhaustion instant for a run that will end the window', () => {
    // 2x every day: a 30-day budget is gone after 15 days.
    const analysis = analyzeCsv(steady(T0, T0 + 10 * DAY, STEP, 2));
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    assert.equal(slo.budget.exhaustsAt, T0 + 15 * DAY);
    assert.equal(slo.budget.exhaustsInSeconds, 5 * DAY / 1000);
    assert.equal(slo.budget.state, 'burning');
  });

  it('uses a fixed window when periodStart is given', () => {
    // A five-day window that started five days ago, burning 2x, is exactly done.
    const analysis = analyzeCsv(steady(T0, T0 + 5 * DAY, STEP, 2), {
      slos: [{ ...SLO, periodSeconds: 5 * DAY / 1000, periodStart: T0 }],
    });
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    assert.equal(slo.budget.elapsedFraction, 1);
    assert.equal(slo.budget.state, 'exhausted');
  });

  it('scores only as much of the window as it has data for', () => {
    // Ten days of data cannot score a rolling 30-day SLO: the period window is
    // only a third covered, so the rate is withheld rather than guessed.
    const analysis = analyzeCsv(steady(T0, T0 + TEN_DAYS, STEP, 0.5), {
      slos: [{ name: 'rolling', objective: 0.999, periodSeconds: 30 * DAY / 1000 }],
    });
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    assert.equal(slo.period.sufficient, false);
    assert.equal(slo.period.burnRate, 0);
    assert.ok(slo.period.coverage < 0.5);
    assert.match(slo.budget.notes.join(' '), /provisional/);
  });

  it('starts the rolling window at the analysis instant minus the period', () => {
    const analysis = analyzeCsv(steady(T0, T0 + TEN_DAYS, STEP, 0.5), {
      slos: [{ name: 'rolling', objective: 0.999, periodSeconds: 30 * DAY / 1000 }],
    });
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    assert.equal(slo.budget.elapsedFraction, 1);
    assert.equal(slo.budget.periodStart, analysis.asOf - 30 * DAY);
    assert.equal(slo.budget.periodEnd, analysis.asOf);
  });

  it('builds a burn-rate curve with one point per interval', () => {
    const analysis = analyzeCsv(steady(T0, T0 + HOUR, STEP, 1));
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    assert.equal(slo.curve.length, 12);
    closeTo(slo.curve[0]?.burnRate ?? 0, 1, 1e-4);
  });

  it('is deterministic for the same input', () => {
    const schedule = sequence(
      steady(T0, T0 + 2 * DAY, STEP, 0.5),
      steady(T0 + 2 * DAY, T0 + 3 * DAY, STEP, 9),
    );
    assert.deepEqual(analyzeCsv(schedule), analyzeCsv(schedule));
  });

  it('honours an explicit as-of instant', () => {
    const schedule = steady(T0, T0 + 10 * DAY, STEP, 0.5);
    const document = parseTabular(csvFrom(schedule, BUDGET_RATIO), 'csv');
    const analysis = analyze({ slos: [SLO], document, asOf: T0 + 5 * DAY });
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    assert.equal(analysis.asOf, T0 + 5 * DAY);
    assert.equal(slo.period.end, T0 + 5 * DAY);
  });
  it('flags a data-driven gate when a window is thinly covered', () => {
    // Twenty minutes of data cannot support a three-day rule window.
    const analysis = analyzeCsv(steady(T0, T0 + 20 * MINUTE, MINUTE, 20));
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    const longBurn = slo.alerts.find((alert) => alert.rule.id === 'long-burn-ticket');
    assert.ok(longBurn !== undefined);
    assert.equal(longBurn.evaluated, false);
    assert.match(longBurn.note, /not evaluated/);
  });

  it('refuses to mix tabular input with label selectors', () => {
    const document = parseTabular(csvFrom(steady(T0, T0 + HOUR, STEP, 1), BUDGET_RATIO), 'csv');
    assert.throws(
      () => analyze({ slos: [SLO_WITH_SELECTORS], document }),
      /tabular input is already split/,
    );
  });

  it('refuses more than one SLO over tabular input', () => {
    const document = parseTabular(csvFrom(steady(T0, T0 + HOUR, STEP, 1), BUDGET_RATIO), 'csv');
    assert.throws(
      () => analyze({ slos: [SLO, { ...SLO, name: 'other' }], document }),
      /exactly one SLO/,
    );
  });

  it('refuses input with no samples', () => {
    const document = parseTabular('timestamp,good,bad\n', 'csv');
    assert.throws(() => analyze({ slos: [SLO], document }), /no timestamped samples/);
  });

  it('clamps a period start that lies in the future', () => {
    const analysis = analyzeCsv(steady(T0, T0 + HOUR, STEP, 1), {
      slos: [{ ...SLO, periodStart: T0 + 5 * DAY }],
    });
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    assert.match(slo.warnings.join(' '), /clamped to start now/);
  });
});

describe('analyze over Prometheus input', () => {
  it('scores an SLO selected by label matchers', () => {
    const document = parsePrometheus(promFrom(steady(T0, T0 + 2 * DAY, STEP, 0.5), BUDGET_RATIO));
    const analysis = analyze({ slos: [SLO_WITH_SELECTORS], document });
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    assert.equal(slo.goodSeriesCount, 1);
    assert.equal(slo.badSeriesCount, 1);
    closeTo(slo.period.burnRate, 0.5, 1e-4);
    assert.equal(slo.budget.state, 'healthy');
  });

  it('scores several SLOs from one document', () => {
    const document = parsePrometheus(promFrom(steady(T0, T0 + 2 * DAY, STEP, 2), BUDGET_RATIO));
    const analysis = analyze({
      slos: [
        SLO_WITH_SELECTORS,
        { ...SLO_WITH_SELECTORS, name: 'payments', objective: 0.99 },
      ],
      document,
    });
    assert.equal(analysis.slos.length, 2);
    // A 99% objective has a ten-times larger budget, so the burn rate drops.
    const [first, second] = analysis.slos;
    closeTo(first?.period.burnRate ?? 0, 2, 1e-4);
    closeTo(second?.period.burnRate ?? 0, 0.2, 1e-4);
  });

  it('warns that a missing bad selector reads as a zero error rate', () => {
    const document = parsePrometheus(promFrom(steady(T0, T0 + 2 * DAY, STEP, 2), BUDGET_RATIO));
    const analysis = analyze({
      slos: [{ ...SLO_WITH_SELECTORS, bad: { matchers: { code: '=~4..' } } }],
      document,
    });
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    assert.equal(slo.badSeriesCount, 0);
    assert.match(slo.warnings.join(' '), /error rate will read as zero/);
    assert.equal(slo.period.burnRate, 0);
  });

  it('carries skipped input lines into the data-quality report', () => {
    const document = parsePrometheus(`${promFrom(steady(T0, T0 + HOUR, STEP, 1), BUDGET_RATIO)}garbage line\n`);
    const analysis = analyze({ slos: [SLO_WITH_SELECTORS], document });
    assert.equal(analysis.dataQuality.length, 1);
    assert.match(analysis.dataQuality[0]?.message ?? '', /does not match/);
  });
});

describe('observations', () => {
  it('explains the burn rate, the budget and the firing rules', () => {
    const analysis = analyzeCsv(steady(T0, T0 + TEN_DAYS, STEP, 4));
    const observations = analysis.slos[0]?.observations ?? [];
    assert.equal(observations.length >= 5, true);
    const text = observations.join('\n');
    assert.match(text, /Error rate .* against a 99\.90% objective \(budget 0\.1%\)/);
    assert.match(text, /faster than sustainable/);
    assert.match(text, /of the budget consumed after/);
    assert.match(text, /already exhausted/);
    assert.match(text, /2 of 4 rules firing/);
  });
});
