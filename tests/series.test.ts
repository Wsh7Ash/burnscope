import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { counterDelta, increase, intervalRates, windowRate } from '../src/series.js';
import type { Sample } from '../src/types.js';
import { DAY, HOUR, MINUTE, T0, closeTo, counters, sequence, steady } from './_helpers.js';

const BUDGET_RATIO = 0.001;
const PERIOD = 30 * DAY / 1000;

function samples(pairs: readonly [number, number][]): Sample[] {
  return pairs.map(([t, v]) => ({ t, v }));
}

describe('counterDelta', () => {
  it('is the plain difference when the counter climbs', () => {
    assert.equal(counterDelta(10, 25), 15);
  });

  it('treats a decrease as a reset and keeps the post-reset value', () => {
    assert.equal(counterDelta(1000, 12), 12);
    assert.equal(counterDelta(0, 0), 0);
  });
});

describe('increase', () => {
  it('sums the deltas inside the window', () => {
    const series = samples([
      [0, 0],
      [60_000, 10],
      [120_000, 25],
      [180_000, 40],
    ]);
    const result = increase(series, 60_000, 180_000);
    assert.equal(result.value, 30); // 15 + 15
    assert.equal(result.points, 2);
    assert.equal(result.sufficient, true);
  });

  it('uses the last sample at or before the window start as the baseline', () => {
    const series = samples([
      [0, 0],
      [30_000, 100],
      [60_000, 200],
      [90_000, 260],
    ]);
    // Window (30s, 90s]: baseline 100, deltas 100 + 60.
    assert.equal(increase(series, 30_000, 90_000).value, 160);
  });

  it('accumulates across a counter reset', () => {
    const series = samples([
      [0, 0],
      [60_000, 100],
      [120_000, 5], // process restarted
      [180_000, 25],
    ]);
    // 100 up, then a reset contributes 5, then 20.
    assert.equal(increase(series, 0, 180_000).value, 125);
  });

  it('reports no samples when the window is empty', () => {
    const result = increase(samples([[0, 0], [1000, 5]]), 10_000, 20_000);
    assert.equal(result.value, 0);
    assert.equal(result.sufficient, false);
    assert.match(result.reason, /no samples inside the window/);
  });

  it('marks a window as insufficient when the span is too short', () => {
    const series = samples([
      [0, 0],
      [1000, 10],
      [2000, 20],
    ]);
    // A one-hour window with two seconds of data.
    const result = increase(series, 0, HOUR);
    assert.equal(result.sufficient, false);
    assert.equal(result.observedSeconds, 2);
    assert.match(result.reason, /covered only/);
  });

  it('marks a window as insufficient when there is no pre-window baseline', () => {
    const series = samples([
      [HOUR - 60_000, 0],
      [HOUR, 10],
      [2 * HOUR, 20],
    ]);
    const result = increase(series, 0, 2 * HOUR);
    assert.equal(result.sufficient, false);
    assert.match(result.reason, /truncated/);
    assert.equal(result.baseline, null);
  });

  it('rejects a window whose samples share one timestamp', () => {
    const result = increase(samples([[0, 5], [0, 9]]), 0, HOUR);
    assert.equal(result.observedSeconds, 0);
    assert.equal(result.sufficient, false);
  });

  it('honours a custom coverage floor', () => {
    // The last sample is 30 minutes before the window closes, so the measured
    // span covers only half the hour.
    const series = samples([
      [0, 0],
      [30 * MINUTE, 10],
    ]);
    const result = increase(series, 0, HOUR);
    assert.equal(result.observedSeconds, 1800);
    assert.equal(increase(series, 0, HOUR, { minCoverage: 0.5 }).sufficient, true);
    assert.equal(increase(series, 0, HOUR, { minCoverage: 0.9 }).sufficient, false);
  });
});

describe('windowRate', () => {
  it('turns a measured ratio into a burn rate', () => {
    // 1.44% failures against a 0.1% budget is 14.4x.
    const schedule = steady(T0, T0 + 3 * HOUR, 5 * MINUTE, 14.4);
    const { good, bad } = counters(schedule, BUDGET_RATIO);
    const rate = windowRate({
      label: 'fast',
      windowSeconds: HOUR / 1000,
      asOf: T0 + 3 * HOUR,
      good,
      bad,
      budgetRatio: BUDGET_RATIO,
      periodSeconds: PERIOD,
    });
    closeTo(rate.errorRate, 0.0144, 1e-6);
    closeTo(rate.burnRate, 14.4, 1e-4);
    assert.equal(rate.sufficient, true);
    assert.equal(rate.coverage, 1);
  });

  it('charges a window the share of the budget its length represents', () => {
    const { good, bad } = counters(steady(T0, T0 + 2 * HOUR, 5 * MINUTE, 14.4), BUDGET_RATIO);
    const rate = windowRate({
      label: 'fast',
      windowSeconds: HOUR / 1000,
      asOf: T0 + 2 * HOUR,
      good,
      bad,
      budgetRatio: BUDGET_RATIO,
      periodSeconds: PERIOD,
    });
    // 14.4 * (1h / 720h) = 2% of a 30-day budget.
    closeTo(rate.budgetConsumed, 0.02, 1e-4);
  });

  it('reads zero error rate when nothing failed', () => {
    const { good, bad } = counters(steady(T0, T0 + 2 * HOUR, 5 * MINUTE, 0), BUDGET_RATIO);
    const rate = windowRate({
      label: 'quiet',
      windowSeconds: HOUR / 1000,
      asOf: T0 + 2 * HOUR,
      good,
      bad,
      budgetRatio: BUDGET_RATIO,
      periodSeconds: PERIOD,
    });
    assert.equal(rate.errorRate, 0);
    assert.equal(rate.burnRate, 0);
    assert.equal(rate.budgetConsumed, 0);
    assert.equal(rate.sufficient, true);
  });

  it('anchors sufficiency on the good series', () => {
    // Failures are silent, but the denominator series is fully covered.
    const good = samples([
      [T0, 0],
      [T0 + HOUR, 1000],
    ]);
    const rate = windowRate({
      label: 'quiet',
      windowSeconds: HOUR / 1000,
      asOf: T0 + HOUR,
      good,
      bad: [],
      budgetRatio: BUDGET_RATIO,
      periodSeconds: PERIOD,
    });
    assert.equal(rate.sufficient, true);
    assert.equal(rate.burnRate, 0);
  });

  it('is insufficient when the good series is not covered', () => {
    const rate = windowRate({
      label: 'sparse',
      windowSeconds: 3 * DAY / 1000,
      asOf: T0 + 3 * DAY,
      good: samples([
        [T0, 0],
        [T0 + 1000, 10],
      ]),
      bad: [],
      budgetRatio: BUDGET_RATIO,
      periodSeconds: PERIOD,
    });
    assert.equal(rate.sufficient, false);
    assert.equal(rate.burnRate, 0);
    assert.match(rate.note, /covered only/);
  });

  it('averages across a recovery', () => {
    // Two hours at 20x then two hours at zero, measured over the last hour.
    const schedule = sequence(
      steady(T0, T0 + 2 * HOUR, 5 * MINUTE, 20),
      steady(T0 + 2 * HOUR, T0 + 4 * HOUR, 5 * MINUTE, 0),
    );
    const { good, bad } = counters(schedule, BUDGET_RATIO);
    const rate = windowRate({
      label: 'short',
      windowSeconds: HOUR / 1000,
      asOf: T0 + 4 * HOUR,
      good,
      bad,
      budgetRatio: BUDGET_RATIO,
      periodSeconds: PERIOD,
    });
    assert.equal(rate.burnRate, 0, 'the last hour saw no failures at all');
  });
});

describe('intervalRates', () => {
  it('reports one point per pair of consecutive timestamps', () => {
    const { good, bad } = counters(steady(T0, T0 + HOUR, 5 * MINUTE, 2), BUDGET_RATIO);
    const curve = intervalRates(good, bad, BUDGET_RATIO);
    assert.equal(curve.length, 12);
    for (const point of curve) closeTo(point.burnRate, 2, 1e-4);
  });

  it('emits a zero-error point for a quiet interval', () => {
    const { good, bad } = counters(steady(T0, T0 + 30 * MINUTE, 5 * MINUTE, 0), BUDGET_RATIO);
    const curve = intervalRates(good, bad, BUDGET_RATIO);
    assert.equal(curve.length, 6);
    assert.equal(curve[0]?.burnRate, 0);
  });

  it('skips intervals that carried no traffic', () => {
    const good = samples([
      [0, 0],
      [1000, 0],
      [2000, 10],
    ]);
    const bad = samples([
      [0, 0],
      [1000, 0],
      [2000, 0],
    ]);
    const curve = intervalRates(good, bad, BUDGET_RATIO);
    assert.equal(curve.length, 1, 'the first interval had no events at all');
  });

  it('skips intervals missing from one series rather than guessing', () => {
    const good = samples([
      [0, 0],
      [1000, 10],
      [2000, 20],
    ]);
    const bad = samples([
      [0, 0],
      [2000, 1],
    ]);
    assert.equal(intervalRates(good, bad, BUDGET_RATIO).length, 0);
  });

  it('handles a counter reset inside the curve', () => {
    const good = samples([
      [0, 0],
      [1000, 100],
      [2000, 0], // reset
      [3000, 5],
    ]);
    const bad = samples([
      [0, 0],
      [1000, 0],
      [2000, 0],
      [3000, 1],
    ]);
    const curve = intervalRates(good, bad, BUDGET_RATIO);
    // Three intervals, but the one spanning the reset carried no events at all
    // and is therefore skipped rather than reported as a rate.
    assert.equal(curve.length, 2);
    // The last interval counts 5 good and 1 failure.
    assert.equal(curve[1]?.burnRate, (1 / 6) / BUDGET_RATIO);
  });
});
