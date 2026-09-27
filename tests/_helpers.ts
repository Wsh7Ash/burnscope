import type { Sample } from '../src/types.js';

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Fixed epoch so every derived number in the suite is reproducible. */
export const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

/** Events per interval. Large enough that rounding never moves a burn rate. */
const INTERVAL_EVENTS = 1_000_000;

/** Canonical scrape interval used across the suite. */
export const STEP_MS = 5 * MINUTE;

export interface BurnStep {
  /** Epoch ms at which this interval ends. */
  readonly t: number;
  /** Burn rate to hold over the interval leading up to `t`. */
  readonly burn: number;
}

export interface CounterPair {
  readonly good: readonly Sample[];
  readonly bad: readonly Sample[];
}

/**
 * Build good and bad counter samples that hit the requested burn rates.
 *
 * Each interval contributes `INTERVAL_EVENTS` events, of which
 * `burn * budgetRatio * INTERVAL_EVENTS` are failures, so the measured error
 * ratio reproduces the requested burn rate to within float rounding.
 *
 * A zero-valued baseline is written one step *before* the first interval, which
 * is what a real counter looks like: a zero reading that then accumulates.
 */
export function counters(schedule: readonly BurnStep[], budgetRatio: number): CounterPair {
  const good: Sample[] = [];
  const bad: Sample[] = [];
  const first = schedule[0];
  if (first === undefined) return { good, bad };

  const second = schedule[1];
  const stepMs = second === undefined ? MINUTE : second.t - first.t;
  good.push({ t: first.t - stepMs, v: 0 });
  bad.push({ t: first.t - stepMs, v: 0 });

  let goodTotal = 0;
  let badTotal = 0;
  for (const step of schedule) {
    const failures = Math.min(INTERVAL_EVENTS, Math.round(step.burn * budgetRatio * INTERVAL_EVENTS));
    badTotal += failures;
    goodTotal += INTERVAL_EVENTS - failures;
    good.push({ t: step.t, v: goodTotal });
    bad.push({ t: step.t, v: badTotal });
  }
  return { good, bad };
}

/** A schedule holding one burn rate from `from` to `to` in `stepMs` slices. */
export function steady(from: number, to: number, stepMs: number, burn: number): BurnStep[] {
  const out: BurnStep[] = [];
  for (let t = from + stepMs; t <= to; t += stepMs) out.push({ t, burn });
  return out;
}

/** Concatenate schedules, dropping any step that is not strictly later. */
export function sequence(...parts: readonly BurnStep[][]): BurnStep[] {
  const out: BurnStep[] = [];
  for (const part of parts) {
    for (const step of part) {
      if (out.length === 0 || step.t > (out[out.length - 1]?.t ?? 0)) out.push(step);
    }
  }
  return out;
}

export function tabularDocument(
  entries: readonly { t: number; good: number; bad: number }[],
): { good: Sample[]; bad: Sample[] } {
  return {
    good: entries.map((entry) => ({ t: entry.t, v: entry.good })),
    bad: entries.map((entry) => ({ t: entry.t, v: entry.bad })),
  };
}

/** Render a burn schedule as the `timestamp,good,bad` CSV a user would write. */
export function csvFrom(schedule: readonly BurnStep[], budgetRatio: number): string {
  const { good, bad } = counters(schedule, budgetRatio);
  const rows = ['timestamp,good,bad'];
  for (let i = 0; i < good.length; i += 1) {
    const g = good[i];
    const b = bad[i];
    if (g === undefined || b === undefined) continue;
    rows.push(`${new Date(g.t).toISOString()},${g.v},${b.v}`);
  }
  return `${rows.join('\n')}\n`;
}

/** The same schedule in Prometheus text exposition format. */
export function promFrom(schedule: readonly BurnStep[], budgetRatio: number): string {
  const { good, bad } = counters(schedule, budgetRatio);
  const lines: string[] = ['# HELP requests_total Total requests', '# TYPE requests_total counter'];
  for (let i = 0; i < good.length; i += 1) {
    const g = good[i];
    const b = bad[i];
    if (g === undefined || b === undefined) continue;
    lines.push(`requests_total{code="200",job="api"} ${g.v} ${g.t}`);
    lines.push(`requests_total{code="500",job="api"} ${b.v} ${b.t}`);
  }
  return `${lines.join('\n')}\n`;
}

export function closeTo(actual: number, expected: number, tolerance = 1e-9): void {
  const delta = Math.abs(actual - expected);
  if (delta > tolerance) {
    throw new Error(`expected ${actual} to be within ${tolerance} of ${expected} (off by ${delta})`);
  }
}
