import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GOOGLE_SRE_PROFILE, evaluateAlerts, expectedConsumed, getProfile } from '../src/mwmb.js';
import { DAY, HOUR, MINUTE, T0, closeTo, counters, sequence, steady } from './_helpers.js';

const BUDGET_RATIO = 0.001;
const PERIOD = 30 * DAY / 1000;

describe('google-sre profile', () => {
  it('reproduces the published budget-consumed figures', () => {
    // Each rule's published figure must equal burnRate * longWindow / 30d,
    // which is the check that the table was transcribed correctly.
    for (const rule of GOOGLE_SRE_PROFILE.rules) {
      closeTo(expectedConsumed(rule, PERIOD), rule.publishedConsumed, 1e-12);
    }
    assert.deepEqual(
      GOOGLE_SRE_PROFILE.rules.map((rule) => rule.publishedConsumed),
      [0.02, 0.05, 0.1, 0.1],
    );
  });

  it('has the four documented window pairs, in seconds', () => {
    const minute = 60;
    const hour = 3_600;
    const day = 86_400;
    assert.deepEqual(
      GOOGLE_SRE_PROFILE.rules.map((rule) => [
        rule.longWindowSeconds,
        rule.shortWindowSeconds,
        rule.burnRate,
      ]),
      [
        [hour, 5 * minute, 14.4],
        [6 * hour, 30 * minute, 6],
        [day, 2 * hour, 3],
        [3 * day, 6 * hour, 1],
      ],
    );
  });

  it('is the default profile and is looked up by id', () => {
    assert.equal(getProfile(undefined), GOOGLE_SRE_PROFILE);
    assert.equal(getProfile('google-sre'), GOOGLE_SRE_PROFILE);
    assert.throws(() => getProfile('nope'), /unknown alert profile/);
  });

  it('recovers a published figure for a different period', () => {
    const fast = GOOGLE_SRE_PROFILE.rules[0];
    assert.ok(fast !== undefined);
    // In a 7-day period the same 14.4x rule eats far more of the budget.
    closeTo(expectedConsumed(fast, 7 * DAY / 1000), 14.4 * (1 / 168), 1e-12);
  });
});

function evaluate(schedule: Parameters<typeof counters>[0]) {
  const { good, bad } = counters(schedule, BUDGET_RATIO);
  return evaluateAlerts({
    profile: GOOGLE_SRE_PROFILE,
    series: { good, bad, goodLabels: [{}], badLabels: [{}], warnings: [] },
    asOf: schedule[schedule.length - 1]?.t ?? 0,
    objective: 0.999,
    periodSeconds: PERIOD,
    minCoverage: 0.5,
  });
}

describe('evaluateAlerts', () => {
  it('fires the fast-burn rule during a severe spike', () => {
    const results = evaluate(steady(T0, T0 + 2 * HOUR, MINUTE, 20));
    const fast = results.find((entry) => entry.rule.id === 'fast-burn-page');
    assert.ok(fast !== undefined);
    assert.equal(fast.firing, true);
    assert.equal(fast.evaluated, true);
    closeTo(fast.long.burnRate, 20, 1e-4);
    closeTo(fast.short.burnRate, 20, 1e-4);
    assert.match(fast.note, /^firing/);
  });

  it('fires every rule when the service is broken across the whole window', () => {
    const results = evaluate(steady(T0, T0 + 4 * DAY, 5 * MINUTE, 20));
    assert.equal(results.filter((entry) => entry.firing).length, GOOGLE_SRE_PROFILE.rules.length);
  });

  it('stays clear when the service is healthy', () => {
    const results = evaluate(steady(T0, T0 + 4 * DAY, 5 * MINUTE, 0.5));
    assert.equal(results.filter((entry) => entry.firing).length, 0);
    for (const entry of results) assert.match(entry.note, /^clear/);
  });

  it('needs both windows to agree: a hot long window alone does not fire', () => {
    // An outage that ended ten minutes before the analysis instant. The hour
    // window is still mostly on fire; the five-minute window has recovered.
    const schedule = sequence(
      steady(T0, T0 + 2 * HOUR, MINUTE, 20),
      steady(T0 + 2 * HOUR, T0 + 2 * HOUR + 10 * MINUTE, MINUTE, 0),
    );
    const results = evaluate(schedule);
    const fast = results.find((entry) => entry.rule.id === 'fast-burn-page');
    assert.ok(fast !== undefined);
    assert.ok(fast.long.burnRate >= 14.4, `long window should still be hot, got ${fast.long.burnRate}`);
    assert.equal(fast.short.burnRate, 0);
    assert.equal(fast.firing, false);
    assert.match(fast.note, /fast-burn-page\/short/);
  });

  it('reports the short window as the reason when only it has healed', () => {
    // Twenty hours at 4x then four hours healthy: the day window still burns
    // above 3x, but the two-hour window has recovered to nothing.
    const schedule = sequence(
      steady(T0, T0 + 20 * HOUR, MINUTE, 4),
      steady(T0 + 20 * HOUR, T0 + 24 * HOUR, MINUTE, 0),
    );
    const results = evaluate(schedule);
    const slow = results.find((entry) => entry.rule.id === 'slow-burn-ticket');
    assert.ok(slow !== undefined);
    assert.ok(slow.long.burnRate > 3, `long window should still burn, got ${slow.long.burnRate}`);
    assert.equal(slow.short.burnRate, 0);
    assert.equal(slow.firing, false);
    assert.match(slow.note, /slow-burn-ticket\/short/);
  });

  it('reports the long window as the reason when only it is hot', () => {
    // The mirror image: a recent spike the day window has not yet absorbed.
    const schedule = sequence(
      steady(T0, T0 + 23 * HOUR, MINUTE, 0),
      steady(T0 + 23 * HOUR, T0 + 24 * HOUR, MINUTE, 20),
    );
    const results = evaluate(schedule);
    const slow = results.find((entry) => entry.rule.id === 'slow-burn-ticket');
    assert.ok(slow !== undefined);
    assert.equal(slow.firing, false, 'one hour of 20x does not clear a 3x day threshold');
    assert.match(slow.note, /slow-burn-ticket\/long/);
  });

  it('refuses to evaluate a rule whose window is not covered', () => {
    // Only five minutes of data cannot support a three-day window.
    const results = evaluate(steady(T0, T0 + 5 * MINUTE, MINUTE, 20));
    for (const entry of results) {
      assert.equal(entry.evaluated, false);
      assert.equal(entry.firing, false);
      assert.match(entry.note, /^not evaluated/);
    }
  });

  it('tolerates sparse data once coverage clears the floor', () => {
    // Hourly samples across four days: every window is fully covered.
    const results = evaluate(steady(T0, T0 + 4 * DAY, HOUR, 20));
    assert.equal(results.every((entry) => entry.evaluated), true);
    assert.equal(results.filter((entry) => entry.firing).length, GOOGLE_SRE_PROFILE.rules.length);
  });

  it('keeps rule severities in the order the table lists them', () => {
    assert.deepEqual(
      GOOGLE_SRE_PROFILE.rules.map((rule) => rule.severity),
      ['page', 'page', 'ticket', 'ticket'],
    );
  });
});
