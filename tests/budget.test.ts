import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AT_RISK_REMAINING, budgetState, budgetStatus } from '../src/budget.js';
import { DAY, HOUR, closeTo } from './_helpers.js';

const THIRTY_DAYS = 30 * DAY;
const PERIOD_START = Date.UTC(2026, 0, 1);

function ledger(overrides: Partial<Parameters<typeof budgetStatus>[0]> = {}) {
  return budgetStatus({
    objective: 0.999,
    periodSeconds: THIRTY_DAYS / 1000,
    periodStart: PERIOD_START,
    asOf: PERIOD_START + 10 * DAY,
    periodBurnRate: 1,
    periodSufficient: true,
    ...overrides,
  });
}

describe('budgetStatus', () => {
  it('derives the budget ratio from the objective', () => {
    closeTo(ledger({ objective: 0.999 }).budgetRatio, 0.001, 1e-12);
    closeTo(ledger({ objective: 0.99 }).budgetRatio, 0.01, 1e-12);
    closeTo(ledger({ objective: 0.9995 }).budgetRatio, 0.0005, 1e-12);
    // 1 - 0.9 is not exactly representable, so this is a tolerance, not equality.
    closeTo(ledger({ objective: 0.9 }).budgetRatio, 0.1, 1e-15);
  });

  it('scales consumption by how far into the window the analysis sits', () => {
    // 3x burn, one third of a 30-day window elapsed: exactly the whole budget.
    const status = ledger({ periodBurnRate: 3, asOf: PERIOD_START + 10 * DAY });
    assert.ok(Math.abs(status.consumed - 1) < 1e-12);
    assert.equal(status.remaining, 0);
    assert.equal(status.state, 'exhausted');
    assert.equal(status.exhaustsInSeconds, 0);
  });

  it('does not charge a full window for a partially elapsed one', () => {
    // 4x burn after only 10 of 30 days: 4 * 10/30 = 133% used.
    const tenDays = ledger({ periodBurnRate: 4, asOf: PERIOD_START + 10 * DAY });
    assert.ok(Math.abs(tenDays.consumed - 4 / 3) < 1e-12);
    assert.equal(tenDays.remaining, 0);
    assert.equal(tenDays.elapsedFraction, 1 / 3);

    // The same rate measured a day earlier is nowhere near exhausted.
    const oneDay = ledger({ periodBurnRate: 4, asOf: PERIOD_START + DAY });
    assert.ok(Math.abs(oneDay.consumed - 4 / 30) < 1e-12);
    assert.ok(oneDay.remaining > 0.86);
    assert.equal(oneDay.state, 'burning');
  });

  it('projects the budget left at the end of the window', () => {
    const status = ledger({ periodBurnRate: 0.5, asOf: PERIOD_START + 30 * DAY });
    assert.equal(status.projectedRemaining, 0.5);
  });

  it('projects exhaustion at one over the burn rate', () => {
    // 3x burns the 30-day budget in a third of it: 10 days from the start.
    const status = ledger({ periodBurnRate: 3, asOf: PERIOD_START });
    assert.ok(Math.abs(status.elapsedFraction) < 1e-12);
    assert.equal(status.exhaustsAt, PERIOD_START + 10 * DAY);
    assert.equal(status.exhaustsInSeconds, (10 * DAY) / 1000);
  });

  it('reports the runway left from the analysis instant', () => {
    // 6x burns a 30-day budget in 5 days; one day in, four days of runway remain.
    const status = ledger({ periodBurnRate: 6, asOf: PERIOD_START + DAY });
    assert.equal(status.exhaustsAt, PERIOD_START + 5 * DAY);
    assert.equal(status.exhaustsInSeconds, (4 * DAY) / 1000);
  });

  it('treats a zero burn rate as inexhaustible', () => {
    const status = ledger({ periodBurnRate: 0, asOf: PERIOD_START + 30 * DAY });
    assert.equal(status.neverExhausts, true);
    assert.equal(status.exhaustsAt, null);
    assert.equal(status.exhaustsInSeconds, null);
    assert.equal(status.remaining, 1);
    assert.equal(status.state, 'healthy');
    assert.match(status.notes.join(' '), /cannot be exhausted/);
  });

  it('clamps the elapsed fraction and says so when the instant is past the window', () => {
    const status = ledger({ periodBurnRate: 1, asOf: PERIOD_START + 45 * DAY });
    assert.equal(status.elapsedFraction, 1);
    assert.match(status.notes.join(' '), /past the end of the SLO window/);
  });

  it('flags an untrustworthy period measurement', () => {
    const status = ledger({ periodSufficient: false });
    assert.match(status.notes.join(' '), /provisional/);
  });

  it('never reports a negative remaining budget', () => {
    const status = ledger({ periodBurnRate: 50 });
    assert.equal(status.remaining, 0);
    assert.ok(status.consumed > 1);
  });

  it('exposes the window bounds', () => {
    const status = ledger();
    assert.equal(status.periodStart, PERIOD_START);
    assert.equal(status.periodEnd, PERIOD_START + THIRTY_DAYS);
    assert.equal(status.elapsedSeconds, (10 * DAY) / 1000);
  });
});

describe('budgetState', () => {
  it('prefers exhausted over burning', () => {
    assert.equal(budgetState(0, 10), 'exhausted');
  });

  it('reports burning once the sustainable rate is exceeded', () => {
    assert.equal(budgetState(0.5, 1), 'burning');
    assert.equal(budgetState(0.5, 1.5), 'burning');
  });

  it('reports at risk below the remaining-budget threshold', () => {
    assert.equal(budgetState(AT_RISK_REMAINING, 0.5), 'healthy');
    assert.equal(budgetState(AT_RISK_REMAINING - 1e-9, 0.5), 'at-risk');
  });

  it('reports healthy otherwise', () => {
    assert.equal(budgetState(0.9, 0.2), 'healthy');
  });
});

describe('window arithmetic', () => {
  it('treats one over the burn rate as exactly sustainable', () => {
    const status = ledger({
      periodSeconds: 7 * DAY / 1000,
      periodStart: PERIOD_START,
      asOf: PERIOD_START + 7 * DAY,
      periodBurnRate: 1,
    });
    // A full 7-day window at exactly 1x consumes precisely the budget.
    closeTo(status.consumed, 1, 1e-12);
    assert.equal(status.remaining, 0);
    assert.equal(status.state, 'exhausted');
  });

  it('scales a fast burn by the share of the period it covered', () => {
    // 24x for a single hour inside a 7-day period: 24 * (1h / 168h) = 14.3%.
    const status = ledger({
      periodSeconds: 7 * DAY / 1000,
      periodStart: PERIOD_START,
      asOf: PERIOD_START + HOUR,
      periodBurnRate: 24,
    });
    closeTo(status.consumed, 24 / 168, 1e-12);
    assert.equal(status.exhaustsAt, PERIOD_START + (7 * DAY) / 24);
  });

  it('handles a period shorter than an hour', () => {
    const status = ledger({ periodSeconds: HOUR / 1000, asOf: PERIOD_START + HOUR, periodBurnRate: 1 });
    assert.equal(status.elapsedFraction, 1);
    assert.equal(status.remaining, 0);
  });
});
