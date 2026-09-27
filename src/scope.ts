import { budgetStatus } from './budget.js';
import { SpecError } from './errors.js';
import { formatBurn, formatDuration, formatErrorRate, formatPercent, trimZeros } from './format.js';
import { evaluateAlerts, getProfile, GOOGLE_SRE_PROFILE } from './mwmb.js';
import type { TabularDocument } from './parse/tabular.js';
import { collectSloSeries } from './select.js';
import { DEFAULT_MIN_COVERAGE, intervalRates, windowRate } from './series.js';
import type {
  AlertProfile,
  Analysis,
  DataQualityNote,
  MetricsDocument,
  SloResult,
  SloSeries,
  SloSpec,
} from './types.js';

export interface AnalyzeInput {
  readonly slos: readonly SloSpec[];
  /** Parsed metric input. Tabular documents carry pre-split good/bad counters. */
  readonly document: MetricsDocument | TabularDocument;
  /** Analysis instant (epoch ms). Defaults to the newest sample in the input. */
  readonly asOf?: number;
  /** Minimum window coverage before a rate is trusted, default `0.5`. */
  readonly minCoverage?: number;
  /** Alert rule set, default the Google SRE workbook profile. */
  readonly profile?: AlertProfile;
}

function isTabular(document: MetricsDocument | TabularDocument): document is TabularDocument {
  return document.format === 'csv' || document.format === 'json';
}

/**
 * analyze every SLO against one metric document.
 *
 * The analysis instant defaults to the newest sample in the input, which keeps
 * results reproducible: re-running on the same file always yields the same
 * numbers.
 */
export function analyze(input: AnalyzeInput): Analysis {
  const minCoverage = input.minCoverage ?? DEFAULT_MIN_COVERAGE;
  const profile = input.profile ?? getProfile(undefined);
  const { document } = input;

  const asOf = input.asOf ?? document.lastTimestamp;
  if (asOf === null || asOf === undefined) {
    throw new SpecError('cannot analyze: the input contains no timestamped samples');
  }

  const tabular = isTabular(document);
  if (tabular && input.slos.length > 1) {
    throw new SpecError(
      'tabular input holds a single good/bad pair, so it can serve exactly one SLO; ' +
        'use Prometheus input for multiple SLOs',
    );
  }

  const dataQuality: DataQualityNote[] = [];
  for (const skipped of document.skipped) {
    dataQuality.push({ scope: `input line ${skipped.line}`, message: `${skipped.reason}` });
  }

  const slos = input.slos.map((spec) => evaluateSlo(spec, document, tabular, asOf, minCoverage, profile));
  return { asOf, profile, slos, skipped: document.skipped, dataQuality, minCoverage };
}

function evaluateSlo(
  spec: SloSpec,
  document: MetricsDocument | TabularDocument,
  tabular: boolean,
  asOf: number,
  minCoverage: number,
  profile: AlertProfile,
): SloResult {
  const series: SloSeries = tabular
    ? collectTabular(document as TabularDocument, spec)
    : collectSloSeries(document, spec);

  const warnings: string[] = [...series.warnings];
  const budgetRatio = 1 - spec.objective;

  let periodStart = resolvePeriodStart(spec, asOf);
  if (periodStart > asOf) {
    warnings.push('periodStart is after the analysis instant; the SLO window was clamped to start now');
    periodStart = asOf;
  }
  const elapsedSeconds = Math.max(0, (asOf - periodStart) / 1000);

  if (series.good.length < 2) {
    warnings.push(
      `only ${series.good.length} good-counter sample(s) available; burn rates cannot be computed reliably`,
    );
  }

  // The period window is exactly the elapsed part of the SLO window, so its
  // nominal length is the elapsed time. This keeps `budgetConsumed` correct:
  // consuming budget for 3 of 30 days must not be scored as if all 30 had run.
  const period = windowRate({
    label: 'period',
    windowSeconds: elapsedSeconds,
    asOf,
    good: series.good,
    bad: series.bad,
    budgetRatio,
    periodSeconds: spec.periodSeconds,
    minCoverage,
  });

  const budget = budgetStatus({
    objective: spec.objective,
    periodSeconds: spec.periodSeconds,
    periodStart,
    asOf,
    periodBurnRate: period.burnRate,
    periodSufficient: period.sufficient,
  });

  const alerts = evaluateAlerts({
    profile,
    series,
    asOf,
    objective: spec.objective,
    periodSeconds: spec.periodSeconds,
    minCoverage,
  });
  const firing = alerts.filter((alert) => alert.firing);

  return {
    spec,
    asOf,
    goodSeriesCount: series.goodLabels.length,
    badSeriesCount: series.badLabels.length,
    period,
    budget,
    alerts,
    firing,
    curve: intervalRates(series.good, series.bad, budgetRatio),
    observations: buildObservations(spec, period, budget, firing, profile),
    warnings,
  };
}

function collectTabular(document: TabularDocument, spec: SloSpec): SloSeries {
  if (spec.metric !== undefined || spec.good !== undefined || spec.bad !== undefined) {
    throw new SpecError(
      `SLO ${JSON.stringify(spec.name)} declares label selectors, but tabular input is already split into ` +
        'good and bad counters; remove "metric"/"good"/"bad" or switch to Prometheus input',
    );
  }
  return {
    good: document.good,
    bad: document.bad,
    goodLabels: [{}],
    badLabels: [{}],
    warnings: [],
  };
}

function resolvePeriodStart(spec: SloSpec, asOf: number): number {
  if (spec.periodStart === undefined) {
    // No explicit start: treat the SLO as a rolling window ending now.
    return asOf - spec.periodSeconds * 1000;
  }
  return toEpochMs(spec.periodStart);
}

/** Promote a raw period start (epoch seconds, epoch ms or ISO-8601) to epoch ms. */
function toEpochMs(value: number | string): number {
  if (typeof value === 'number') return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  return Date.parse(value);
}

function buildObservations(
  spec: SloSpec,
  period: { burnRate: number; errorRate: number; sufficient: boolean; observedSeconds: number; label: string },
  budget: SloResult['budget'],
  firing: readonly { rule: { severity: string; id: string; burnRate: number } }[],
  profile: AlertProfile,
): string[] {
  const out: string[] = [];

  if (period.sufficient) {
    out.push(
      `Error rate ${formatErrorRate(period.errorRate)} against a ` +
        `${formatPercent(spec.objective, 2)} objective (budget ${trimZeros((budget.budgetRatio * 100).toFixed(3))}%).`,
    );
    out.push(
      `Burn rate over the SLO window is ${formatBurn(period.burnRate)} ` +
        `(${formatBurn(period.burnRate) === '1x' ? 'exactly sustainable' : period.burnRate >= 1 ? 'faster than sustainable' : 'slower than sustainable'}).`,
    );
  } else {
    out.push(`Burn rate unavailable: ${period.label} is not sufficiently covered (${formatDuration(period.observedSeconds)} of data).`);
  }

  out.push(
    `${formatPercent(budget.consumed)} of the budget consumed after ` +
      `${formatPercent(budget.elapsedFraction)} of the window has elapsed; ` +
      `${formatPercent(budget.remaining)} remaining.`,
  );

  if (budget.neverExhausts) {
    out.push('At this rate the budget cannot be exhausted.');
  } else if (budget.exhaustsInSeconds === 0) {
    out.push('At this rate the budget is already exhausted.');
  } else if (budget.exhaustsInSeconds !== null) {
    out.push(
      `Projected exhaustion in ${formatDuration(budget.exhaustsInSeconds)} at the current rate.`,
    );
  }

  const pages = firing.filter((alert) => alert.rule.severity === 'page').length;
  const tickets = firing.length - pages;
  if (firing.length === 0) {
    out.push(`No ${profile.name} alert rules are firing.`);
  } else {
    const parts: string[] = [];
    if (pages > 0) parts.push(`${pages} page`);
    if (tickets > 0) parts.push(`${tickets} ticket`);
    out.push(
      `${firing.length} of ${profile.rules.length} rules firing (${parts.join(' and ')}): ` +
        firing.map((alert) => alert.rule.id).join(', '),
    );
  }

  return out;
}

export { GOOGLE_SRE_PROFILE };
