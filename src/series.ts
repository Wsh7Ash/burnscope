import { clamp01, formatPercent } from './format.js';
import type { IntervalRate, Sample, WindowRate } from './types.js';

/** Outcome of a counter increase over a window. */
export interface Increase {
  /** Accumulated increase, treating a counter reset as "restarted at zero". */
  readonly value: number;
  /** Sample used as the pre-window baseline, if one exists. */
  readonly baseline: Sample | null;
  /** Last sample inside the window. */
  readonly last: Sample | null;
  /** Seconds between the baseline and the last in-window sample. */
  readonly observedSeconds: number;
  /** Number of in-window samples considered. */
  readonly points: number;
  /** True when the span covered enough of the window to trust the rate. */
  readonly sufficient: boolean;
  readonly reason: string;
}

export interface IncreaseOptions {
  /** Minimum `observedSeconds / windowSeconds` required, default `0.5`. */
  readonly minCoverage?: number;
}

export const DEFAULT_MIN_COVERAGE = 0.5;

/**
 * Accumulated increase of a counter over `(startMs, endMs]`.
 *
 * Mirrors the semantics of Prometheus `increase()`: a decrease is read as a
 * counter reset, in which case the post-reset value is itself the increase.
 * No extrapolation to the window edges is performed; the caller decides whether
 * the observed span is good enough via `sufficient`.
 */
export function increase(
  samples: readonly Sample[],
  startMs: number,
  endMs: number,
  options: IncreaseOptions = {},
): Increase {
  const minCoverage = options.minCoverage ?? DEFAULT_MIN_COVERAGE;
  const windowSeconds = Math.max(0, (endMs - startMs) / 1000);

  let baseline: Sample | null = null;
  let inWindow: Sample[] = [];
  for (const sample of samples) {
    if (sample.t <= startMs) {
      baseline = sample;
    } else if (sample.t <= endMs) {
      inWindow.push(sample);
    }
  }

  if (inWindow.length === 0) {
    return {
      value: 0,
      baseline,
      last: null,
      observedSeconds: 0,
      points: 0,
      sufficient: false,
      reason: 'no samples inside the window',
    };
  }

  const anchor = baseline ?? inWindow[0] ?? null;
  if (anchor === null) {
    return {
      value: 0,
      baseline: null,
      last: null,
      observedSeconds: 0,
      points: 0,
      sufficient: false,
      reason: 'no samples available',
    };
  }

  let previous = anchor.v;
  let total = 0;
  for (const sample of inWindow) {
    const delta = sample.v - previous;
    total += delta < 0 ? sample.v : delta;
    previous = sample.v;
  }

  const last = inWindow[inWindow.length - 1] ?? null;
  const observedSeconds = Math.max(0, ((last?.t ?? anchor.t) - anchor.t) / 1000);
  const coverage = windowSeconds > 0 ? clamp01(observedSeconds / windowSeconds) : 0;

  let reason = 'ok';
  let sufficient = true;
  if (baseline === null) {
    sufficient = false;
    reason = 'no sample at or before the window start; span is truncated';
  } else if (observedSeconds <= 0) {
    sufficient = false;
    reason = 'all samples share one timestamp; no time passed';
  } else if (coverage < minCoverage) {
    sufficient = false;
    reason = `covered only ${formatPercent(coverage)} of the window (need ${formatPercent(minCoverage)})`;
  }

  return {
    value: total,
    baseline,
    last,
    observedSeconds,
    points: inWindow.length,
    sufficient,
    reason,
  };
}

export interface WindowRateInput {
  readonly label: string;
  /** Nominal window length in seconds; drives `budgetConsumed`. */
  readonly windowSeconds: number;
  readonly asOf: number;
  readonly good: readonly Sample[];
  readonly bad: readonly Sample[];
  readonly budgetRatio: number;
  readonly periodSeconds: number;
  readonly minCoverage?: number;
}

/**
 * Measure good/bad error ratio and budget consumption over one window.
 *
 * The window is anchored on the `good` series: the error rate is a ratio whose
 * denominator is the good counter's increase, so that is the series whose
 * coverage decides whether the rate is trustworthy. A `bad` series that is
 * simply quiet still yields a legitimate zero error rate.
 */
export function windowRate(input: WindowRateInput): WindowRate {
  const minCoverage = input.minCoverage ?? DEFAULT_MIN_COVERAGE;
  const end = input.asOf;
  const start = end - input.windowSeconds * 1000;

  const goodIncrease = increase(input.good, start, end, { minCoverage });
  const badIncrease = increase(input.bad, start, end, { minCoverage });

  const good = goodIncrease.value;
  const bad = badIncrease.value;
  const total = good + bad;
  const errorRate = total > 0 ? bad / total : 0;

  const coverage =
    input.windowSeconds > 0 ? clamp01(goodIncrease.observedSeconds / input.windowSeconds) : 0;
  const sufficient = goodIncrease.sufficient;
  // Withhold the burn rate when too little of the window was covered: a rate
  // computed from a truncated span would silently understate the burn. The
  // measured ratio stays visible via `errorRate` and the `note` explains why.
  const burnRate = sufficient
    ? input.budgetRatio > 0
      ? errorRate / input.budgetRatio
      : 0
    : 0;
  const budgetConsumed =
    input.periodSeconds > 0 ? burnRate * (input.windowSeconds / input.periodSeconds) : 0;

  return {
    label: input.label,
    windowSeconds: input.windowSeconds,
    observedSeconds: goodIncrease.observedSeconds,
    coverage,
    good,
    bad,
    total,
    errorRate,
    burnRate,
    budgetConsumed,
    sufficient,
    note: sufficient ? 'ok' : goodIncrease.reason,
    start,
    end,
  };
}

/**
 * Per-scrape error rate and burn rate, used for the burn-rate chart.
 *
 * Intervals are formed between consecutive timestamps that are present in both
 * series; an interval present in only one series is skipped rather than
 * guessed at.
 */
export function intervalRates(
  good: readonly Sample[],
  bad: readonly Sample[],
  budgetRatio: number,
): IntervalRate[] {
  const goodAt = new Map<number, number>();
  for (const sample of good) goodAt.set(sample.t, sample.v);
  const badAt = new Map<number, number>();
  for (const sample of bad) badAt.set(sample.t, sample.v);

  const timeline = [...new Set([...goodAt.keys(), ...badAt.keys()])].sort((a, b) => a - b);
  const out: IntervalRate[] = [];

  for (let i = 0; i + 1 < timeline.length; i += 1) {
    const t0 = timeline[i];
    const t1 = timeline[i + 1];
    if (t0 === undefined || t1 === undefined) continue;
    const g0 = goodAt.get(t0);
    const g1 = goodAt.get(t1);
    const b0 = badAt.get(t0);
    const b1 = badAt.get(t1);
    if (g0 === undefined || g1 === undefined || b0 === undefined || b1 === undefined) continue;

    const dg = counterDelta(g0, g1);
    const db = counterDelta(b0, b1);
    const total = dg + db;
    if (total <= 0) continue;

    const errorRate = db / total;
    out.push({
      t: t1,
      good: dg,
      bad: db,
      total,
      errorRate,
      burnRate: budgetRatio > 0 ? errorRate / budgetRatio : 0,
    });
  }

  return out;
}

/** Counter delta that treats a decrease as a reset. */
export function counterDelta(from: number, to: number): number {
  const delta = to - from;
  return delta < 0 ? to : delta;
}
