import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ParseError, SpecError } from '../src/errors.js';
import { parseTabular, parseTimestamp, splitCsvLine } from '../src/parse/tabular.js';

const T = 1_767_225_600_000; // 2026-01-01T00:00:00Z

describe('splitCsvLine', () => {
  it('splits plain fields', () => {
    assert.deepEqual(splitCsvLine('a,b,c'), ['a', 'b', 'c']);
  });

  it('keeps commas inside quotes', () => {
    assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  });

  it('unescapes doubled quotes', () => {
    assert.deepEqual(splitCsvLine('a,"b""c"'), ['a', 'b"c']);
  });

  it('returns a single empty field for an empty line', () => {
    assert.deepEqual(splitCsvLine(''), ['']);
  });
});

describe('parseTimestamp', () => {
  it('reads epoch seconds and milliseconds by magnitude', () => {
    assert.equal(parseTimestamp(1_767_225_600), T);
    assert.equal(parseTimestamp(T), T);
  });

  it('reads numeric strings', () => {
    assert.equal(parseTimestamp('1767225600'), T);
    assert.equal(parseTimestamp(`${T}`), T);
  });

  it('reads ISO-8601', () => {
    assert.equal(parseTimestamp('2026-01-01T00:00:00Z'), T);
    assert.equal(parseTimestamp('2026-01-01T00:00:00.000Z'), T);
  });

  it('rejects nonsense', () => {
    assert.equal(parseTimestamp('later'), undefined);
    assert.equal(parseTimestamp(''), undefined);
    assert.equal(parseTimestamp(null), undefined);
    assert.equal(parseTimestamp(Number.NaN), undefined);
  });
});

describe('parseTabular csv', () => {
  it('parses a header and rows', () => {
    const doc = parseTabular(
      ['timestamp,good,bad', `${T},100,1`, `${T + 60000},200,4`].join('\n'),
      'csv',
    );
    assert.deepEqual(doc.good, [
      { t: T, v: 100 },
      { t: T + 60_000, v: 200 },
    ]);
    assert.deepEqual(doc.bad, [
      { t: T, v: 1 },
      { t: T + 60_000, v: 4 },
    ]);
    assert.equal(doc.format, 'csv');
    assert.equal(doc.sampleCount, 4);
  });

  it('accepts alternative column names and mixed case', () => {
    const doc = parseTabular(['Time,Errors,OK', `${T},1,100`].join('\n'), 'csv');
    assert.equal(doc.good[0]?.v, 100);
    assert.equal(doc.bad[0]?.v, 1);
  });

  it('skips comments, blank lines and CRLF endings', () => {
    const doc = parseTabular(['# a note', '', 'timestamp,good,bad', `${T},5,0`, ''].join('\r\n'), 'csv');
    assert.equal(doc.good.length, 1);
  });

  it('sorts rows by timestamp', () => {
    const doc = parseTabular(
      ['timestamp,good,bad', `${T + 60000},2,0`, `${T},1,0`].join('\n'),
      'csv',
    );
    assert.deepEqual(doc.good.map((s) => s.t), [T, T + 60_000]);
  });

  it('requires the three columns', () => {
    assert.throws(() => parseTabular('timestamp,good\n1,2\n', 'csv'), /must contain timestamp, good and bad/);
  });

  it('rejects a file with no header', () => {
    assert.throws(() => parseTabular('\n\n', 'csv'), /no header row/);
  });

  it('rejects non-numeric cells in strict mode', () => {
    assert.throws(() => parseTabular(['timestamp,good,bad', `${T},x,1`].join('\n'), 'csv', { strict: true }), ParseError);
  });

  it('skips negative counters by default and rejects them in strict mode', () => {
    const row = ['timestamp,good,bad', `${T},5,-1`].join('\n');
    const lenient = parseTabular(row, 'csv');
    assert.equal(lenient.good.length, 1);
    assert.equal(lenient.bad.length, 0);
    assert.match(lenient.skipped[0]?.reason ?? '', /non-negative/);
    assert.throws(() => parseTabular(row, 'csv', { strict: true }), /non-negative/);
  });
});

describe('parseTabular json', () => {
  it('parses a bare array', () => {
    const doc = parseTabular(
      JSON.stringify([
        { timestamp: T, good: 10, bad: 1 },
        { timestamp: T + 60_000, good: 20, bad: 2 },
      ]),
      'json',
    );
    assert.equal(doc.good.length, 2);
    assert.equal(doc.bad[1]?.v, 2);
  });

  it('parses a samples wrapper', () => {
    const doc = parseTabular(JSON.stringify({ samples: [{ ts: T, ok: 3, failures: 1 }] }), 'json');
    assert.equal(doc.good[0]?.v, 3);
    assert.equal(doc.bad[0]?.v, 1);
  });

  it('reports invalid JSON', () => {
    assert.throws(() => parseTabular('{oops', 'json'), /not valid JSON/);
  });

  it('requires an array or a samples array', () => {
    assert.throws(() => parseTabular('{"a":1}', 'json'), /must be an array/);
  });

  it('requires the three fields on every sample', () => {
    assert.throws(() => parseTabular('[{"timestamp":1,"good":2}]', 'json'), /must provide timestamp, good and bad/);
  });

  it('rejects a non-object sample', () => {
    assert.throws(() => parseTabular('[1,2,3]', 'json', { strict: true }), /must be an object/);
  });

  it('exposes a synthetic series view for inspection', () => {
    const doc = parseTabular(JSON.stringify([{ timestamp: T, good: 1, bad: 0 }]), 'json');
    assert.equal(doc.series.length, 2);
    assert.equal(doc.series[0]?.labels['outcome'], 'good');
  });
});

describe('SpecError', () => {
  it('carries a name so callers can branch on it', () => {
    assert.equal(new SpecError('x').name, 'SpecError');
    assert.ok(new SpecError('x') instanceof Error);
  });
});
