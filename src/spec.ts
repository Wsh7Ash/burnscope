import { SpecError } from './errors.js';
import type { Selector, SloSpec } from './types.js';

const DURATION_UNITS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 604_800,
};

/** Parse `30d`, `1d12h`, `6h`, `90s`, `4w` into seconds. */
export function parseDuration(text: string): number {
  const compact = text.trim().replace(/\s+/g, '');
  if (compact === '') throw new SpecError('duration is empty');
  const pattern = /(\d+(?:\.\d+)?)([smhdw])/g;
  let total = 0;
  let consumed = 0;
  for (const match of compact.matchAll(pattern)) {
    total += Number(match[1]) * (DURATION_UNITS[match[2] ?? 's'] ?? 1);
    consumed += match[0].length;
  }
  if (consumed !== compact.length) {
    throw new SpecError(`invalid duration ${JSON.stringify(text)}; expected forms like 30d, 6h, 1d12h`);
  }
  if (total <= 0) throw new SpecError(`duration ${JSON.stringify(text)} must be positive`);
  return total;
}

export interface SpecFile {
  readonly slos: readonly SloSpec[];
  readonly profileId: string | undefined;
}

/** Parse an SLO spec file. Accepts JSON; durations may be written as `30d`. */
export function parseSpec(text: string): SpecFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SpecError(`spec file is not valid JSON: ${(error as Error).message}`);
  }
  return parseSpecValue(value);
}

export function parseSpecValue(value: unknown): SpecFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpecError('spec file must be a JSON object with an "slos" array');
  }
  const root = value as Record<string, unknown>;
  const rawSlos = root['slos'];
  if (!Array.isArray(rawSlos) || rawSlos.length === 0) {
    throw new SpecError('spec file must contain a non-empty "slos" array');
  }

  const seen = new Set<string>();
  const slos = rawSlos.map((raw, index) => {
    const slo = parseSlo(raw, index);
    if (seen.has(slo.name)) {
      throw new SpecError(`duplicate SLO name ${JSON.stringify(slo.name)}`);
    }
    seen.add(slo.name);
    return slo;
  });

  const profile = root['alertProfile'] ?? root['profile'];
  if (profile !== undefined && typeof profile !== 'string') {
    throw new SpecError('"alertProfile" must be a string when present');
  }

  return { slos, profileId: profile as string | undefined };
}

function parseSlo(raw: unknown, index: number): SloSpec {
  const where = `slos[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SpecError(`${where} must be an object`);
  }
  const map = raw as Record<string, unknown>;

  const name = map['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    throw new SpecError(`${where}.name must be a non-empty string`);
  }

  const objective = map['objective'];
  if (typeof objective !== 'number' || !Number.isFinite(objective) || objective <= 0 || objective >= 1) {
    throw new SpecError(`${where}.objective must be a number strictly between 0 and 1`);
  }

  const periodSeconds = resolvePeriod(map, where);
  const description = map['description'];
  if (description !== undefined && typeof description !== 'string') {
    throw new SpecError(`${where}.description must be a string when present`);
  }

  const periodStartRaw = map['periodStart'];
  let periodStart: number | string | undefined;
  if (periodStartRaw !== undefined) {
    if (typeof periodStartRaw !== 'string' && typeof periodStartRaw !== 'number') {
      throw new SpecError(`${where}.periodStart must be an ISO-8601 string or epoch number`);
    }
    validateInstant(periodStartRaw, `${where}.periodStart`);
    periodStart = periodStartRaw;
  }

  const metric = map['metric'];
  if (metric !== undefined && (typeof metric !== 'string' || metric.trim() === '')) {
    throw new SpecError(`${where}.metric must be a non-empty string when present`);
  }

  const good = parseSelector(map['good'], `${where}.good`);
  const bad = parseSelector(map['bad'], `${where}.bad`);

  const present = [metric !== undefined, good !== undefined, bad !== undefined].filter(Boolean).length;
  if (present !== 0 && present !== 3) {
    throw new SpecError(`${where} must define "metric", "good" and "bad" together, or none of them`);
  }

  return {
    name: name.trim(),
    ...(description === undefined ? {} : { description }),
    objective,
    periodSeconds,
    ...(periodStart === undefined ? {} : { periodStart }),
    ...(typeof metric === 'string' ? { metric } : {}),
    ...(good === undefined ? {} : { good }),
    ...(bad === undefined ? {} : { bad }),
  };
}

function resolvePeriod(map: Record<string, unknown>, where: string): number {
  const seconds = map['periodSeconds'];
  const period = map['period'];
  if (seconds !== undefined && period !== undefined) {
    throw new SpecError(`${where} must define either "period" or "periodSeconds", not both`);
  }
  if (typeof seconds === 'number') {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new SpecError(`${where}.periodSeconds must be a positive number`);
    }
    return seconds;
  }
  if (typeof period === 'string') return parseDuration(period);
  if (period === undefined) {
    throw new SpecError(`${where} must define "period" (e.g. "30d") or "periodSeconds"`);
  }
  throw new SpecError(`${where}.period must be a duration string such as "30d"`);
}

function parseSelector(raw: unknown, where: string): Selector | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SpecError(`${where} must be an object of label matchers`);
  }
  const map = raw as Record<string, unknown>;
  // Accept both `{ "matchers": { code: "2.." } }` and the flat `{ code: "2.." }`.
  const source =
    map['matchers'] !== undefined && map['matchers'] !== null && typeof map['matchers'] === 'object'
      ? (map['matchers'] as Record<string, unknown>)
      : map;

  const matchers: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'matchers') continue;
    if (typeof value !== 'string') {
      throw new SpecError(`${where} matcher ${JSON.stringify(key)} must be a string`);
    }
    matchers[key] = value;
  }
  if (Object.keys(matchers).length === 0) {
    throw new SpecError(`${where} must match at least one label`);
  }
  return { matchers };
}

/**
 * Check that a period start denotes a real instant. The raw value is kept as
 * written — epoch seconds, epoch milliseconds or ISO-8601 — and normalization
 * to epoch milliseconds happens where the analysis runs.
 */
function validateInstant(value: string | number, where: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SpecError(`${where} is not a finite number`);
    return;
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new SpecError(`${where} ${JSON.stringify(value)} is not an ISO-8601 timestamp`);
  }
}
