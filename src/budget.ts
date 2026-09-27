import { clamp01 } from './format.js';
import type { BudgetState, BudgetStatus } from './types.js';

/** Below this remaining budget the SLO is called out as at risk. */
export const AT_RISK_REMAINING = 0.25;

export interface BudgetInput {
  /** Availability target in [0, 1). */
  readonly objective: number;
  /** SLO window length in seconds. */
  readonly periodSeconds: number;
  /** Start of the SLO window (epoch ms). */
  readonly periodStart: number;
  /** Analysis instant (epoch ms). */
  readonly asOf: number;
  /** Burn rate measured from `periodStart` to `asOf`. */
  readonly periodBurnRate: number;
  /** Whether that period measurement was trustworthy. */
  readonly periodSufficient: boolean;
}

/**
 * Error-budget ledger and exhaustion projection.
 *
 * Definitions, with the SLO window running from `periodStart` for
 * `periodSeconds` and the analysis happening `elapsedFraction` of the way
 * through it:
 *
 * - `consumed`   = `burnRate * elapsedFraction` — budget used so far.
 * - `remaining`  = `max(0, 1 - consumed)`.
 * - `projectedRemaining` = `max(0, 1 - burnRate)` — what would be left at the end
 *   of the window if the current rate holds for the whole period.
 * - Exhaustion happens when cumulative burn reaches 1.0, i.e. after
 *   `1 / burnRate` of the window has elapsed. Projecting that instant forward
 *   gives `exhaustsAt` and the runway `exhaustsInSeconds`.
 *
 * A burn rate of exactly 1.0 is sustainable: it consumes precisely the budget
 * over the full window.
 */
export function budgetStatus(input: BudgetInput): BudgetStatus {
  const budgetRatio = 1 - input.objective;
  const elapsedSeconds = Math.max(0, (input.asOf - input.periodStart) / 1000);
  const elapsedFraction =
    input.periodSeconds > 0 ? clamp01(elapsedSeconds / input.periodSeconds) : 0;
  const periodEnd = input.periodStart + input.periodSeconds * 1000;

  const burn = Number.isFinite(input.periodBurnRate) ? Math.max(0, input.periodBurnRate) : 0;
  const consumed = burn * elapsedFraction;
  const remaining = Math.max(0, 1 - consumed);
  const projectedRemaining = Math.max(0, 1 - burn);

  const notes: string[] = [];
  let exhaustsAt: number | null = null;
  let exhaustsInSeconds: number | null = null;
  let neverExhausts = false;

  if (burn <= 0) {
    neverExhausts = true;
    notes.push('No failed events were measured, so the budget cannot be exhausted.');
  } else {
    const exhaustFraction = 1 / burn;
    if (exhaustFraction <= elapsedFraction) {
      exhaustsInSeconds = 0;
      notes.push('The budget is already exhausted at the measured rate.');
    } else {
      exhaustsAt = input.periodStart + exhaustFraction * input.periodSeconds * 1000;
      // Derive the runway from the projected instant so both figures always
      // agree, and so whole-day projections stay exact integers.
      exhaustsInSeconds = Math.max(0, (exhaustsAt - input.asOf) / 1000);
    }
  }

  if (elapsedSeconds > input.periodSeconds) {
    notes.push(
      'The analysis instant is past the end of the SLO window; elapsed fraction was clamped to 100%.',
    );
  }
  if (!input.periodSufficient) {
    notes.push('The period measurement did not cover enough of the window, so these figures are provisional.');
  }

  return {
    objective: input.objective,
    budgetRatio,
    periodSeconds: input.periodSeconds,
    periodStart: input.periodStart,
    periodEnd,
    elapsedSeconds,
    elapsedFraction,
    consumed,
    remaining,
    projectedRemaining,
    exhaustsAt,
    exhaustsInSeconds,
    neverExhausts,
    state: budgetState(remaining, burn),
    notes,
  };
}

/**
 * Classify the SLO. Precedence: exhausted, then burning (faster than
 * sustainable), then at risk (little left), then healthy.
 */
export function budgetState(remaining: number, burnRate: number): BudgetState {
  if (remaining <= 0) return 'exhausted';
  if (burnRate >= 1) return 'burning';
  if (remaining < AT_RISK_REMAINING) return 'at-risk';
  return 'healthy';
}

export function budgetStateLabel(state: BudgetState): string {
  switch (state) {
    case 'exhausted':
      return 'EXHAUSTED';
    case 'burning':
      return 'BURNING';
    case 'at-risk':
      return 'AT RISK';
    case 'healthy':
      return 'HEALTHY';
  }
}
