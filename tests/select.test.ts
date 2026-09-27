import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SpecError } from '../src/errors.js';
import { collectSloSeries, compileMatcher, matchLabels, mergeCounters } from '../src/select.js';
import { parsePrometheus } from '../src/parse/prometheus.js';
import type { Series, SloSpec } from '../src/types.js';
import { T0 } from './_helpers.js';

function series(name: string, labels: Record<string, string>, points: [number, number][]): Series {
  return { name, labels, samples: points.map(([t, v]) => ({ t: T0 + t, v })) };
}

describe('compileMatcher', () => {
  it('matches an exact value, with or without the = sign', () => {
    assert.equal(compileMatcher('200')('200'), true);
    assert.equal(compileMatcher('200')('500'), false);
    assert.equal(compileMatcher('=200')('200'), true);
  });

  it('supports !=', () => {
    assert.equal(compileMatcher('!=200')('500'), true);
    assert.equal(compileMatcher('!=200')('200'), false);
  });

  it('anchors regular expressions', () => {
    assert.equal(compileMatcher('=~2..')('200'), true);
    assert.equal(compileMatcher('=~2..')('1200'), false, 'Prometheus regexes are fully anchored');
    assert.equal(compileMatcher('=~5.*')('503'), true);
  });

  it('supports negated regular expressions', () => {
    assert.equal(compileMatcher('!~2..')('500'), true);
    assert.equal(compileMatcher('!~2..')('204'), false);
  });

  it('rejects an invalid regular expression', () => {
    assert.throws(() => compileMatcher('=~[unclosed'), SpecError);
  });

  it('treats a value containing = as a literal unless it starts with an operator', () => {
    assert.equal(compileMatcher('a=b')('a=b'), true);
  });
});

describe('matchLabels', () => {
  it('requires every matcher to pass', () => {
    const labels = { code: '200', job: 'api' };
    assert.equal(matchLabels(labels, { code: '=~2..', job: 'api' }), true);
    assert.equal(matchLabels(labels, { code: '=~2..', job: 'web' }), false);
  });

  it('treats a bare matcher value as an exact match, not a pattern', () => {
    // `2..` in Prometheus means a literal string; only `=~2..` is a regex.
    assert.equal(matchLabels({ code: '2..' }, { code: '2..' }), true);
    assert.equal(matchLabels({ code: '200' }, { code: '2..' }), false);
  });

  it('fails when a requested label is absent', () => {
    assert.equal(matchLabels({ code: '200' }, { region: 'eu' }), false);
  });

  it('matches an empty matcher set', () => {
    assert.equal(matchLabels({}, {}), true);
  });
});

describe('mergeCounters', () => {
  it('returns an empty array for no series', () => {
    assert.deepEqual(mergeCounters([]), []);
  });

  it('sums series that share a timeline', () => {
    const merged = mergeCounters([
      series('m', { a: '1' }, [
        [0, 10],
        [1000, 20],
      ]),
      series('m', { a: '2' }, [
        [0, 5],
        [1000, 7],
      ]),
    ]);
    assert.deepEqual(merged, [
      { t: T0, v: 15 },
      { t: T0 + 1000, v: 27 },
    ]);
  });

  it('carries the last value forward for series that scrape less often', () => {
    const merged = mergeCounters([
      series('m', { a: '1' }, [
        [0, 10],
        [1000, 20],
        [2000, 30],
      ]),
      series('m', { a: '2' }, [
        [0, 5],
        [2000, 9],
      ]),
    ]);
    assert.deepEqual(merged, [
      { t: T0, v: 15 },
      { t: T0 + 1000, v: 25 }, // series 2 still reads 5
      { t: T0 + 2000, v: 39 },
    ]);
  });

  it('treats a series that has not started yet as contributing nothing', () => {
    const merged = mergeCounters([
      series('m', { a: '1' }, [
        [0, 10],
        [1000, 20],
      ]),
      series('m', { a: '2' }, [[2000, 4]]),
    ]);
    assert.deepEqual(merged, [
      { t: T0, v: 10 },
      { t: T0 + 1000, v: 20 },
      { t: T0 + 2000, v: 24 },
    ]);
  });

  it('does not concatenate samples in a way that would corrupt deltas', () => {
    // Both series climb by 10 per step; the aggregate must climb by 20, not
    // jump around as a naive concatenation would.
    const merged = mergeCounters([
      series('m', { a: '1' }, [
        [0, 0],
        [1000, 10],
        [2000, 20],
      ]),
      series('m', { a: '2' }, [
        [0, 0],
        [1000, 10],
        [2000, 20],
      ]),
    ]);
    assert.deepEqual(merged.map((s) => s.v), [0, 20, 40]);
  });
});

const SPEC: SloSpec = {
  name: 'api',
  objective: 0.999,
  periodSeconds: 30 * 86_400,
  metric: 'http_requests_total',
  good: { matchers: { code: '=~2..' } },
  bad: { matchers: { code: '=~5..' } },
};

describe('collectSloSeries', () => {
  const doc = parsePrometheus(
    [
      `http_requests_total{code="200",job="api"} 900 ${T0}`,
      `http_requests_total{code="200",job="api"} 1800 ${T0 + 60_000}`,
      `http_requests_total{code="204",job="api"} 100 ${T0}`,
      `http_requests_total{code="204",job="api"} 200 ${T0 + 60_000}`,
      `http_requests_total{code="500",job="api"} 10 ${T0}`,
      `http_requests_total{code="500",job="api"} 30 ${T0 + 60_000}`,
      `other_metric{code="500"} 999 ${T0}`,
    ].join('\n'),
  );

  it('sums the matching good series and the matching bad series', () => {
    const collected = collectSloSeries(doc, SPEC);
    assert.equal(collected.goodLabels.length, 2);
    assert.equal(collected.badLabels.length, 1);
    assert.deepEqual(collected.good, [
      { t: T0, v: 1000 },
      { t: T0 + 60_000, v: 2000 },
    ]);
    assert.deepEqual(collected.bad, [
      { t: T0, v: 10 },
      { t: T0 + 60_000, v: 30 },
    ]);
  });

  it('ignores metrics that do not match the name', () => {
    const collected = collectSloSeries(doc, SPEC);
    assert.equal(collected.bad[1]?.v, 30, 'other_metric is not part of this SLO');
  });

  it('warns when a selector matches nothing', () => {
    const quiet = collectSloSeries(doc, {
      ...SPEC,
      bad: { matchers: { code: '=~4..' } },
    });
    assert.equal(quiet.bad.length, 0);
    assert.match(quiet.warnings.join(' '), /no series matched .*bad selectors/);
    assert.match(quiet.warnings.join(' '), /error rate will read as zero/);
  });

  it('requires the selectors for Prometheus input', () => {
    assert.throws(() => collectSloSeries(doc, omit(SPEC, 'metric')), /needs a "metric"/);
    assert.throws(() => collectSloSeries(doc, omit(SPEC, 'good')), /needs both "good" and "bad"/);
    assert.throws(() => collectSloSeries(doc, omit(SPEC, 'bad')), /needs both "good" and "bad"/);
  });
});

/** Drop a key so `exactOptionalPropertyTypes` does not reject the removal. */
function omit(spec: SloSpec, key: 'metric' | 'good' | 'bad'): SloSpec {
  const copy: Record<string, unknown> = { ...spec };
  delete copy[key];
  return copy as unknown as SloSpec;
}
