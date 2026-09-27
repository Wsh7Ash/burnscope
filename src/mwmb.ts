import type { AlertEvaluation, AlertProfile, AlertRule, SloSeries } from './types.js';
import { windowRate } from './series.js';

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

/**
 * The multi-window, multi-burn-rate alert profile from the Google SRE
 * Workbook, chapter 5 ("Implementing SLOs"), Table 4.
 *
 * Each rule fires only when *both* its long and its short window reach the
 * stated burn rate. The long window supplies sensitivity to a sustained
 * regression; the short window supplies the recovery signal, so a brief blip
 * that has already healed does not page anyone.
 *
 * `publishedConsumed` is the budget the rule is designed to have burned by the
 * end of its long window in a 30-day period. It is redundant with `burnRate`
 * and is kept so the rules can be checked against the published table; see
 * `expectedConsumed`.
 */
export const GOOGLE_SRE_PROFILE: AlertProfile = {
  id: 'google-sre',
  name: 'Google SRE workbook',
  description:
    'Four severity-tiered rules: two fast page-worthy burns and two slower ticket-worthy burns, ' +
    'each gated on a long and a short window agreeing.',
  periodSeconds: 30 * DAY,
  rules: [
    {
      id: 'fast-burn-page',
      severity: 'page',
      longWindowSeconds: HOUR,
      shortWindowSeconds: 5 * MINUTE,
      burnRate: 14.4,
      publishedConsumed: 0.02,
      action: 'Page the on-call: at this rate 2% of the budget is gone in one hour.',
    },
    {
      id: 'medium-burn-page',
      severity: 'page',
      longWindowSeconds: 6 * HOUR,
      shortWindowSeconds: 30 * MINUTE,
      burnRate: 6,
      publishedConsumed: 0.05,
      action: 'Page the on-call: at this rate 5% of the budget is gone in six hours.',
    },
    {
      id: 'slow-burn-ticket',
      severity: 'ticket',
      longWindowSeconds: DAY,
      shortWindowSeconds: 2 * HOUR,
      burnRate: 3,
      publishedConsumed: 0.1,
      action: 'Open a ticket: at this rate 10% of the budget is gone in one day.',
    },
    {
      id: 'long-burn-ticket',
      severity: 'ticket',
      longWindowSeconds: 3 * DAY,
      shortWindowSeconds: 6 * HOUR,
      burnRate: 1,
      publishedConsumed: 0.1,
      action: 'Open a ticket: the budget is being consumed faster than it replenishes.',
    },
  ],
};

export const ALERT_PROFILES: Readonly<Record<string, AlertProfile>> = {
  [GOOGLE_SRE_PROFILE.id]: GOOGLE_SRE_PROFILE,
};

export function getProfile(id: string | undefined): AlertProfile {
  if (id === undefined) return GOOGLE_SRE_PROFILE;
  const profile = ALERT_PROFILES[id];
  if (profile === undefined) {
    throw new Error(`unknown alert profile ${JSON.stringify(id)}; known: ${Object.keys(ALERT_PROFILES).join(', ')}`);
  }
  return profile;
}

/**
 * Fraction of the budget a rule is designed to have consumed by the end of its
 * long window, for a given period length. Equals `publishedConsumed` when the
 * period is 30 days, which is the period the published table assumes.
 */
export function expectedConsumed(rule: AlertRule, periodSeconds: number): number {
  if (periodSeconds <= 0) return 0;
  return rule.burnRate * (rule.longWindowSeconds / periodSeconds);
}

export interface EvaluateInput {
  readonly profile: AlertProfile;
  readonly series: SloSeries;
  readonly asOf: number;
  readonly objective: number;
  readonly periodSeconds: number;
  readonly minCoverage: number;
}

/** Test every rule in a profile against one SLO's series. */
export function evaluateAlerts(input: EvaluateInput): AlertEvaluation[] {
  const budgetRatio = 1 - input.objective;
  return input.profile.rules.map((rule) => {
    const long = windowRate({
      label: `${rule.id}/long`,
      windowSeconds: rule.longWindowSeconds,
      asOf: input.asOf,
      good: input.series.good,
      bad: input.series.bad,
      budgetRatio,
      periodSeconds: input.periodSeconds,
      minCoverage: input.minCoverage,
    });
    const short = windowRate({
      label: `${rule.id}/short`,
      windowSeconds: rule.shortWindowSeconds,
      asOf: input.asOf,
      good: input.series.good,
      bad: input.series.bad,
      budgetRatio,
      periodSeconds: input.periodSeconds,
      minCoverage: input.minCoverage,
    });

    const evaluated = long.sufficient && short.sufficient;
    let firing = false;
    let note: string;

    if (!evaluated) {
      const culprit = !long.sufficient ? long : short;
      note = `not evaluated: ${culprit.label} ${culprit.note}`;
    } else if (long.burnRate < rule.burnRate || short.burnRate < rule.burnRate) {
      const below = long.burnRate < rule.burnRate ? long : short;
      note = `clear: ${below.label} burn ${below.burnRate.toFixed(3)}x is below the ${rule.burnRate}x threshold`;
      firing = false;
    } else {
      firing = true;
      note =
        `firing: long ${long.burnRate.toFixed(2)}x and short ${short.burnRate.toFixed(2)}x ` +
        `both at or above ${rule.burnRate}x`;
    }

    return { rule, long, short, firing, evaluated, note };
  });
}
