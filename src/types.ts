/**
 * Core type definitions for burnscope.
 *
 * Timestamps are epoch milliseconds (number) everywhere in the public API so
 * that arithmetic stays exact and free of timezone surprises. ISO-8601 strings
 * only appear in rendered reports.
 */

/** A single counter/gauge observation. `t` is epoch milliseconds. */
export interface Sample {
  readonly t: number;
  readonly v: number;
}

/** A labelled time series, samples sorted ascending by `t`. */
export interface Series {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly samples: readonly Sample[];
}

/** A line the parser could not interpret, retained for reporting. */
export interface SkippedLine {
  /** 1-based line number within the source document. */
  readonly line: number;
  readonly reason: string;
  readonly text: string;
}

/** Parsed metric input. */
export interface MetricsDocument {
  readonly series: readonly Series[];
  readonly skipped: readonly SkippedLine[];
  /** Parses applied to the source, e.g. `prometheus`, `csv`, `json`. */
  readonly format: string;
  /** Number of samples accepted across all series. */
  readonly sampleCount: number;
  /** Earliest sample timestamp, or null when the document holds no samples. */
  readonly firstTimestamp: number | null;
  /** Latest sample timestamp, or null when the document holds no samples. */
  readonly lastTimestamp: number | null;
}

/**
 * Label matcher set. A matcher value is either an exact string, or a
 * Prometheus-style anchored regular expression prefixed with `=~`.
 */
export interface Selector {
  readonly matchers: Readonly<Record<string, string>>;
}

/** Per-SLO declaration. */
export interface SloSpec {
  readonly name: string;
  readonly description?: string;
  /** Availability target in [0, 1), e.g. `0.999`. */
  readonly objective: number;
  /** Length of the SLO measurement window in seconds, e.g. `2592000` for 30d. */
  readonly periodSeconds: number;
  /**
   * Start of a *fixed* SLO window: epoch seconds, epoch milliseconds or an
   * ISO-8601 string, kept exactly as written in the spec file. When omitted
   * the SLO is treated as a rolling window ending at the analysis instant;
   * the analysis normalizes the raw value to epoch milliseconds.
   */
  readonly periodStart?: number | string;
  /**
   * Counter metric name carrying the event counts. Required for Prometheus
   * input, ignored for tabular input which is already split into good/bad.
   */
  readonly metric?: string;
  readonly good?: Selector;
  readonly bad?: Selector;
}

/** Counter samples split into the SLO's good and bad halves. */
export interface SloSeries {
  readonly good: readonly Sample[];
  readonly bad: readonly Sample[];
  /** Label sets that contributed to `good`. */
  readonly goodLabels: readonly Record<string, string>[];
  /** Label sets that contributed to `bad`. */
  readonly badLabels: readonly Record<string, string>[];
  /** Warnings raised while gathering the series. */
  readonly warnings: readonly string[];
}

/** Measured rate over one window. */
export interface WindowRate {
  readonly label: string;
  /** Nominal window length in seconds; drives the budget-consumed figure. */
  readonly windowSeconds: number;
  /** Seconds actually covered by samples inside the window. */
  readonly observedSeconds: number;
  /** Observed span / nominal window, in (0, 1]. */
  readonly coverage: number;
  /** Increase of the good counter across the window. */
  readonly good: number;
  /** Increase of the bad counter across the window. */
  readonly bad: number;
  /** Total increase (good + bad) across the window. */
  readonly total: number;
  /** `bad / total`, or 0 when the window carried no traffic. */
  readonly errorRate: number;
  /** `errorRate / budgetRatio`; 1.0 is exactly sustainable. */
  readonly burnRate: number;
  /** Fraction of the whole-period error budget this window consumed. */
  readonly budgetConsumed: number;
  /** False when too little of the window was covered to trust the rate. */
  readonly sufficient: boolean;
  /** Why the window is (not) sufficient, or `ok`. */
  readonly note: string;
  readonly start: number | null;
  readonly end: number | null;
}

export type BudgetState = 'healthy' | 'at-risk' | 'burning' | 'exhausted';

/** Error-budget ledger for one SLO. */
export interface BudgetStatus {
  readonly objective: number;
  /** `1 - objective`. */
  readonly budgetRatio: number;
  readonly periodSeconds: number;
  readonly periodStart: number | null;
  readonly periodEnd: number | null;
  readonly elapsedSeconds: number;
  /** Elapsed fraction of the period, clamped to [0, 1]. */
  readonly elapsedFraction: number;
  /** Fraction of the budget consumed so far; may exceed 1. */
  readonly consumed: number;
  /** Fraction of the budget still available, floored at 0. */
  readonly remaining: number;
  /** Fraction that would remain at period end if the current rate holds. */
  readonly projectedRemaining: number;
  /** When the budget hits zero at the current rate (epoch ms), or null. */
  readonly exhaustsAt: number | null;
  /** Seconds until exhaustion, 0 when already spent, null when it cannot run out. */
  readonly exhaustsInSeconds: number | null;
  /** True when the current rate is zero, so the budget cannot be exhausted. */
  readonly neverExhausts: boolean;
  readonly state: BudgetState;
  /** Human-readable notes about the projection. */
  readonly notes: readonly string[];
}

export type Severity = 'page' | 'ticket';

/** One multi-window multi-burn-rate alert rule. */
export interface AlertRule {
  readonly id: string;
  readonly severity: Severity;
  readonly longWindowSeconds: number;
  readonly shortWindowSeconds: number;
  /** Both windows must reach this burn rate for the rule to fire. */
  readonly burnRate: number;
  /** Published budget-consumed figure for a 30-day period. */
  readonly publishedConsumed: number;
  readonly action: string;
}

export interface AlertProfile {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly periodSeconds: number;
  readonly rules: readonly AlertRule[];
}

/** Result of testing one alert rule against the data. */
export interface AlertEvaluation {
  readonly rule: AlertRule;
  readonly long: WindowRate;
  readonly short: WindowRate;
  readonly firing: boolean;
  readonly evaluated: boolean;
  readonly note: string;
}

export interface SloResult {
  readonly spec: SloSpec;
  readonly asOf: number;
  readonly goodSeriesCount: number;
  readonly badSeriesCount: number;
  /** Period-to-date measurement; `windowSeconds` is the elapsed time. */
  readonly period: WindowRate;
  readonly budget: BudgetStatus;
  readonly alerts: readonly AlertEvaluation[];
  readonly firing: readonly AlertEvaluation[];
  /** Per-scrape burn-rate curve, used by the burn-rate chart. */
  readonly curve: readonly IntervalRate[];
  readonly observations: readonly string[];
  readonly warnings: readonly string[];
}

export interface DataQualityNote {
  readonly scope: string;
  readonly message: string;
}

export interface Analysis {
  readonly asOf: number;
  readonly profile: AlertProfile;
  readonly slos: readonly SloResult[];
  readonly skipped: readonly SkippedLine[];
  readonly dataQuality: readonly DataQualityNote[];
  /** Minimum window coverage required before a rate is trusted. */
  readonly minCoverage: number;
}

/** One point of the per-scrape burn-rate curve used for charting. */
export interface IntervalRate {
  readonly t: number;
  readonly good: number;
  readonly bad: number;
  readonly total: number;
  readonly errorRate: number;
  readonly burnRate: number;
}
