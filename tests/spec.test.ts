import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SpecError } from '../src/errors.js';
import { parseDuration, parseSpec, parseSpecValue } from '../src/spec.js';

const MINIMAL = {
  slos: [
    {
      name: 'checkout',
      objective: 0.999,
      period: '30d',
      metric: 'http_requests_total',
      good: { code: '=~2..' },
      bad: { code: '=~5..' },
    },
  ],
};

describe('parseDuration', () => {
  it('reads single units', () => {
    assert.equal(parseDuration('30d'), 2_592_000);
    assert.equal(parseDuration('6h'), 21_600);
    assert.equal(parseDuration('30m'), 1_800);
    assert.equal(parseDuration('90s'), 90);
    assert.equal(parseDuration('4w'), 2_419_200);
  });

  it('reads compound durations', () => {
    assert.equal(parseDuration('1d12h'), 129_600);
    assert.equal(parseDuration('1h 30m'), 5_400);
  });

  it('reads fractional amounts', () => {
    assert.equal(parseDuration('0.5h'), 1_800);
  });

  it('rejects nonsense', () => {
    assert.throws(() => parseDuration('30'), /invalid duration/);
    assert.throws(() => parseDuration('30x'), /invalid duration/);
    assert.throws(() => parseDuration('d'), /invalid duration/);
    assert.throws(() => parseDuration(''), /empty/);
    assert.throws(() => parseDuration('0d'), /must be positive/);
  });
});

describe('parseSpec', () => {
  it('parses a minimal spec', () => {
    const spec = parseSpec(JSON.stringify(MINIMAL));
    assert.equal(spec.slos.length, 1);
    const slo = spec.slos[0];
    assert.equal(slo?.name, 'checkout');
    assert.equal(slo?.objective, 0.999);
    assert.equal(slo?.periodSeconds, 2_592_000);
    assert.equal(slo?.metric, 'http_requests_total');
    assert.deepEqual(slo?.good, { matchers: { code: '=~2..' } });
    assert.equal(spec.profileId, undefined);
  });

  it('accepts the nested matchers form', () => {
    const spec = parseSpecValue({
      slos: [
        {
          name: 'x',
          objective: 0.99,
          periodSeconds: 86_400,
          metric: 'm',
          good: { matchers: { code: '2..' } },
          bad: { matchers: { code: '5..' } },
        },
      ],
    });
    assert.deepEqual(spec.slos[0]?.good, { matchers: { code: '2..' } });
  });

  it('accepts a tabular spec with no selectors', () => {
    const spec = parseSpecValue({ slos: [{ name: 'x', objective: 0.99, period: '7d' }] });
    assert.equal(spec.slos[0]?.metric, undefined);
    assert.equal(spec.slos[0]?.good, undefined);
  });

  it('reads periodSeconds as a number', () => {
    const spec = parseSpecValue({
      slos: [{ name: 'x', objective: 0.99, periodSeconds: 3600 }],
    });
    assert.equal(spec.slos[0]?.periodSeconds, 3600);
  });

  it('reads the alert profile', () => {
    const spec = parseSpecValue({ ...MINIMAL, alertProfile: 'google-sre' });
    assert.equal(spec.profileId, 'google-sre');
  });

  it('reads a fixed period start', () => {
    const spec = parseSpecValue({
      slos: [{ ...MINIMAL.slos[0], periodStart: '2026-01-01T00:00:00Z' }],
    });
    assert.equal(spec.slos[0]?.periodStart, '2026-01-01T00:00:00Z');
  });

  it('reads an epoch period start', () => {
    const spec = parseSpecValue({ slos: [{ ...MINIMAL.slos[0], periodStart: 1_767_225_600 }] });
    assert.equal(spec.slos[0]?.periodStart, 1_767_225_600);
  });

  it('rejects invalid JSON', () => {
    assert.throws(() => parseSpec('{oops'), SpecError);
  });

  it('rejects a document with no SLOs', () => {
    assert.throws(() => parseSpecValue({ slos: [] }), /non-empty "slos" array/);
    assert.throws(() => parseSpecValue({}), /non-empty "slos" array/);
    assert.throws(() => parseSpecValue([]), /must be a JSON object/);
  });

  it('rejects a duplicate name', () => {
    assert.throws(
      () => parseSpecValue({ slos: [MINIMAL.slos[0], MINIMAL.slos[0]] }),
      /duplicate SLO name/,
    );
  });

  it('rejects an objective outside (0, 1)', () => {
    for (const objective of [0, 1, 1.5, -0.1]) {
      assert.throws(
        () => parseSpecValue({ slos: [{ name: 'x', objective, period: '30d' }] }),
        /objective must be a number strictly between 0 and 1/,
      );
    }
  });

  it('rejects a missing name', () => {
    assert.throws(() => parseSpecValue({ slos: [{ objective: 0.99, period: '30d' }] }), /name must be/);
  });

  it('rejects a missing period', () => {
    assert.throws(() => parseSpecValue({ slos: [{ name: 'x', objective: 0.99 }] }), /must define "period"/);
  });

  it('rejects both period forms at once', () => {
    assert.throws(
      () => parseSpecValue({ slos: [{ name: 'x', objective: 0.99, period: '30d', periodSeconds: 10 }] }),
      /not both/,
    );
  });

  it('rejects a partial selector set', () => {
    assert.throws(
      () => parseSpecValue({ slos: [{ ...MINIMAL.slos[0], bad: undefined }] }),
      /must define "metric", "good" and "bad" together/,
    );
  });

  it('rejects an empty matcher set', () => {
    assert.throws(
      () => parseSpecValue({ slos: [{ ...MINIMAL.slos[0], good: {} }] }),
      /must match at least one label/,
    );
  });

  it('rejects a non-string matcher value', () => {
    assert.throws(
      () => parseSpecValue({ slos: [{ ...MINIMAL.slos[0], good: { code: 200 } }] }),
      /must be a string/,
    );
  });

  it('rejects an unparseable period start', () => {
    assert.throws(
      () => parseSpecValue({ slos: [{ ...MINIMAL.slos[0], periodStart: 'whenever' }] }),
      /is not an ISO-8601 timestamp/,
    );
  });

  it('rejects a non-string alert profile', () => {
    assert.throws(() => parseSpecValue({ ...MINIMAL, alertProfile: 7 }), /must be a string/);
  });
});
