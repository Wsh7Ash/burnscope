import { SpecError } from './errors.js';
import type { Sample, Series, SloSeries, SloSpec } from './types.js';

type Predicate = (value: string) => boolean;

const cache = new Map<string, Predicate>();

/**
 * Compile a Prometheus-style label matcher.
 *
 * Supported forms: `exact`, `=exact`, `!=exact`, `=~regex`, `!~regex`.
 * Regexes are fully anchored, as in Prometheus.
 */
export function compileMatcher(raw: string): Predicate {
  const cached = cache.get(raw);
  if (cached !== undefined) return cached;

  let predicate: Predicate;
  if (raw.startsWith('=~')) {
    const pattern = raw.slice(2);
    const regex = compileRegex(pattern, raw);
    predicate = (value) => regex.test(value);
  } else if (raw.startsWith('!~')) {
    const pattern = raw.slice(2);
    const regex = compileRegex(pattern, raw);
    predicate = (value) => !regex.test(value);
  } else if (raw.startsWith('!=')) {
    const expected = raw.slice(2);
    predicate = (value) => value !== expected;
  } else if (raw.startsWith('=')) {
    const expected = raw.slice(1);
    predicate = (value) => value === expected;
  } else {
    predicate = (value) => value === raw;
  }

  cache.set(raw, predicate);
  return predicate;
}

function compileRegex(pattern: string, raw: string): RegExp {
  try {
    return new RegExp(`^(?:${pattern})$`);
  } catch (error) {
    throw new SpecError(`invalid regular expression in matcher ${JSON.stringify(raw)}: ${(error as Error).message}`);
  }
}

/** True when `labels` satisfies every matcher in `selector`. */
export function matchLabels(
  labels: Readonly<Record<string, string>>,
  matchers: Readonly<Record<string, string>>,
): boolean {
  for (const [key, raw] of Object.entries(matchers)) {
    const value = labels[key];
    if (value === undefined) return false;
    if (!compileMatcher(raw)(value)) return false;
  }
  return true;
}

/**
 * Sum several counter series into one aggregate counter.
 *
 * At each timestamp the aggregate is the sum of every series' most recent
 * value at or before that timestamp, so series with different scrape times can
 * be added correctly. Concatenating samples instead would corrupt every delta.
 */
export function mergeCounters(list: readonly Series[]): Sample[] {
  if (list.length === 0) return [];
  if (list.length === 1) return [...(list[0]?.samples ?? [])];

  const timeline = new Set<number>();
  for (const series of list) {
    for (const sample of series.samples) timeline.add(sample.t);
  }
  const times = [...timeline].sort((a, b) => a - b);

  const cursors = new Array<number>(list.length).fill(0);
  const values = new Array<number>(list.length).fill(0);
  const started = new Array<boolean>(list.length).fill(false);
  const out: Sample[] = [];

  for (const t of times) {
    let sum = 0;
    for (let i = 0; i < list.length; i += 1) {
      const samples = list[i]?.samples ?? [];
      let j = cursors[i] ?? 0;
      while (j < samples.length && (samples[j]?.t ?? 0) <= t) {
        values[i] = samples[j]?.v ?? 0;
        started[i] = true;
        j += 1;
      }
      cursors[i] = j;
      if (started[i] === true) sum += values[i] ?? 0;
    }
    out.push({ t, v: sum });
  }

  return out;
}

/**
 * Gather the good and bad counters for one SLO from a parsed metric document.
 *
 * Raises `SpecError` when the spec does not carry the selectors a Prometheus
 * input needs, so a misconfigured spec fails loudly rather than silently
 * reporting a perfect score.
 */
export function collectSloSeries(document: { readonly series: readonly Series[] }, spec: SloSpec): SloSeries {
  if (spec.metric === undefined) {
    throw new SpecError(`SLO ${JSON.stringify(spec.name)} needs a "metric" for Prometheus input`);
  }
  if (spec.good === undefined || spec.bad === undefined) {
    throw new SpecError(`SLO ${JSON.stringify(spec.name)} needs both "good" and "bad" label selectors`);
  }

  const goodSeries: Series[] = [];
  const badSeries: Series[] = [];
  for (const series of document.series) {
    if (series.name !== spec.metric) continue;
    if (matchLabels(series.labels, spec.good.matchers)) goodSeries.push(series);
    if (matchLabels(series.labels, spec.bad.matchers)) badSeries.push(series);
  }

  const warnings: string[] = [];
  if (goodSeries.length === 0) {
    warnings.push(`no series matched metric ${spec.metric} with good selectors ${describeSelector(spec.good)}`);
  }
  if (badSeries.length === 0) {
    warnings.push(
      `no series matched metric ${spec.metric} with bad selectors ${describeSelector(spec.bad)}; ` +
        'error rate will read as zero',
    );
  }

  return {
    good: mergeCounters(goodSeries),
    bad: mergeCounters(badSeries),
    goodLabels: goodSeries.map((s) => s.labels),
    badLabels: badSeries.map((s) => s.labels),
    warnings,
  };
}

function describeSelector(selector: { readonly matchers: Readonly<Record<string, string>> } | undefined): string {
  if (selector === undefined) return '{}';
  const pairs = Object.entries(selector.matchers).map(([key, value]) => `${key}${value.startsWith('=') ? '' : '='}${value}`);
  return `{${pairs.join(', ')}}`;
}
