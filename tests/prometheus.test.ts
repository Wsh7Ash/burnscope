import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ParseError } from '../src/errors.js';
import { parseLabels, parsePrometheus } from '../src/parse/prometheus.js';

const T = 1_767_225_600_000; // 2026-01-01T00:00:00Z

describe('parsePrometheus', () => {
  it('parses a metric with labels and a timestamp', () => {
    const doc = parsePrometheus(`http_requests_total{code="200",job="api"} 1234 ${T}\n`);
    assert.equal(doc.series.length, 1);
    const series = doc.series[0];
    assert.equal(series?.name, 'http_requests_total');
    assert.deepEqual(series?.labels, { code: '200', job: 'api' });
    assert.deepEqual(series?.samples, [{ t: T, v: 1234 }]);
    assert.equal(doc.format, 'prometheus');
    assert.equal(doc.firstTimestamp, T);
    assert.equal(doc.lastTimestamp, T);
  });

  it('groups samples that share a name and label set', () => {
    const doc = parsePrometheus(
      [
        `m{a="1"} 1 ${T}`,
        `m{a="1"} 2 ${T + 60_000}`,
        `m{a="2"} 9 ${T}`,
      ].join('\n'),
    );
    assert.equal(doc.series.length, 2);
    const first = doc.series.find((series) => series.labels['a'] === '1');
    assert.equal(first?.samples.length, 2);
    assert.equal(doc.sampleCount, 3);
  });

  it('ignores HELP, TYPE, UNIT and blank lines', () => {
    const doc = parsePrometheus(
      [
        '# HELP http_requests_total Total requests',
        '# TYPE http_requests_total counter',
        '# UNIT http_requests_total requests',
        '',
        `http_requests_total 5 ${T}`,
        '   ',
      ].join('\n'),
    );
    assert.equal(doc.series.length, 1);
    assert.equal(doc.skipped.length, 0);
  });

  it('sorts samples and de-duplicates timestamps keeping the last write', () => {
    const doc = parsePrometheus(
      [`m 3 ${T + 2000}`, `m 1 ${T}`, `m 2 ${T}`].join('\n'),
    );
    assert.deepEqual(doc.series[0]?.samples, [
      { t: T, v: 2 },
      { t: T + 2000, v: 3 },
    ]);
  });

  it('accepts an empty label block and a metric with no labels', () => {
    const doc = parsePrometheus([`m{} 1 ${T}`, `n 2 ${T}`].join('\n'));
    assert.equal(doc.series.length, 2);
    assert.deepEqual(doc.series[0]?.labels, {});
  });

  it('handles label escapes', () => {
    const doc = parsePrometheus(`m{path="a\\"b",note="line\\nbreak",back="c\\\\d"} 1 ${T}\n`);
    assert.deepEqual(doc.series[0]?.labels, { path: 'a"b', note: 'line\nbreak', back: 'c\\d' });
  });

  it('parses float and exponent values', () => {
    const doc = parsePrometheus([`m 1.5 ${T}`, `m 2e3 ${T + 1000}`].join('\n'));
    assert.deepEqual(doc.series[0]?.samples, [
      { t: T, v: 1.5 },
      { t: T + 1000, v: 2000 },
    ]);
  });

  it('collects malformed lines instead of throwing by default', () => {
    const doc = parsePrometheus(
      [
        `m 1 ${T}`,
        '123 456 789', // metric name may not start with a digit
        `m 2 ${T}`,
        `m oops ${T}`,
        'm 3', // no timestamp
      ].join('\n'),
    );
    assert.equal(doc.skipped.length, 4);
    assert.match(doc.skipped[0]?.reason ?? '', /does not match/);
    assert.match(doc.skipped[1]?.reason ?? '', /unparseable value/);
    assert.match(doc.skipped[2]?.reason ?? '', /no timestamp/);
    assert.match(doc.skipped[3]?.reason ?? '', /unparseable value/);
    assert.equal(doc.series[0]?.samples.length, 2);
    // Line numbers are 1-based and point at the offending input.
    assert.equal(doc.skipped[0]?.line, 2);
  });

  it('rejects an unbalanced label block', () => {
    const doc = parsePrometheus(`m{a="1" 5 ${T}\n`);
    assert.equal(doc.series.length, 0);
    assert.match(doc.skipped[0]?.reason ?? '', /does not match/);
  });

  it('drops non-finite values', () => {
    const doc = parsePrometheus([`m NaN ${T}`, `m +Inf ${T}`, `m -Inf ${T}`, `m 1 ${T}`].join('\n'));
    assert.equal(doc.series[0]?.samples.length, 1);
    assert.equal(doc.skipped.length, 3);
    assert.match(doc.skipped[0]?.reason ?? '', /non-finite/);
  });

  it('throws on the first bad line in strict mode', () => {
    assert.throws(() => parsePrometheus(`m 1 ${T}\ngarbage\n`, { strict: true }), ParseError);
  });

  it('reports an empty document without inventing timestamps', () => {
    const doc = parsePrometheus('# only a comment\n');
    assert.deepEqual(doc.series, []);
    assert.equal(doc.sampleCount, 0);
    assert.equal(doc.firstTimestamp, null);
    assert.equal(doc.lastTimestamp, null);
  });
});

describe('parseLabels', () => {
  it('tolerates whitespace and trailing commas between pairs', () => {
    assert.deepEqual(parseLabels('a="1" , b="2",'), { a: '1', b: '2' });
  });

  it('accepts an empty block', () => {
    assert.deepEqual(parseLabels(''), {});
  });

  it('accepts an empty value', () => {
    assert.deepEqual(parseLabels('a=""'), { a: '' });
  });

  it('keeps `=` and other punctuation inside values', () => {
    assert.deepEqual(parseLabels('q="a=b,c=d{e}"'), { q: 'a=b,c=d{e}' });
  });

  it('rejects an unterminated value', () => {
    assert.throws(() => parseLabels('a="1'), ParseError);
  });

  it('rejects a missing closing brace', () => {
    assert.throws(() => parsePrometheus('m{a="1" 5 1000'), /does not match/);
  });

  it('rejects a duplicate label', () => {
    assert.throws(() => parseLabels('a="1",a="2"'), /duplicate/);
  });

  it('rejects an unquoted value', () => {
    assert.throws(() => parseLabels('a=1'), /quoted/);
  });

  it('rejects an invalid escape', () => {
    assert.throws(() => parseLabels('a="\\q"'), /invalid escape/);
  });

  it('rejects a malformed label name', () => {
    assert.throws(() => parseLabels('1a="x"'), /invalid label name/);
  });
});
