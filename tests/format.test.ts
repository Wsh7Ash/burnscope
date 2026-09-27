import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clamp01,
  formatBurn,
  formatCount,
  formatDate,
  formatDuration,
  formatErrorRate,
  formatPercent,
  formatTimestamp,
  formatWindow,
  pad,
  trimZeros,
} from '../src/format.js';

describe('clamp01', () => {
  it('bounds to the unit interval', () => {
    assert.equal(clamp01(-1), 0);
    assert.equal(clamp01(0.5), 0.5);
    assert.equal(clamp01(2), 1);
  });

  it('maps NaN to zero rather than propagating it', () => {
    assert.equal(clamp01(Number.NaN), 0);
  });
});

describe('trimZeros', () => {
  it('drops a trailing fractional zero', () => {
    assert.equal(trimZeros('1.00'), '1');
    assert.equal(trimZeros('14.40'), '14.4');
    assert.equal(trimZeros('0.980'), '0.98');
    assert.equal(trimZeros('1234.0'), '1234');
  });

  it('leaves integers and non-decimals alone', () => {
    assert.equal(trimZeros('5'), '5');
    assert.equal(trimZeros('n/a'), 'n/a');
  });
});

describe('formatPercent', () => {
  it('scales fractions to percentages', () => {
    assert.equal(formatPercent(0.25), '25.00%');
    assert.equal(formatPercent(0.001, 3), '0.100%');
    assert.equal(formatPercent(1), '100.00%');
  });

  it('reports non-finite input as n/a', () => {
    assert.equal(formatPercent(Number.POSITIVE_INFINITY), 'n/a');
  });
});

describe('formatBurn', () => {
  it('renders a multiple of the sustainable rate', () => {
    assert.equal(formatBurn(1), '1x');
    assert.equal(formatBurn(14.4), '14.4x');
    assert.equal(formatBurn(0.98), '0.98x');
    assert.equal(formatBurn(0.0144), '0.014x');
    assert.equal(formatBurn(0), '0x');
    assert.equal(formatBurn(1234), '1234x');
    assert.equal(formatBurn(123.4), '123.4x');
  });
});

describe('formatErrorRate', () => {
  it('keeps enough precision for small SLO budgets', () => {
    assert.equal(formatErrorRate(0.5), '50.00%');
    assert.equal(formatErrorRate(0.01), '1.00%');
    assert.equal(formatErrorRate(0.0042), '0.420%');
    assert.equal(formatErrorRate(0.000012), '1.20e-3%');
    assert.equal(formatErrorRate(0), '0%');
  });
});

describe('formatDuration', () => {
  it('uses at most two units', () => {
    assert.equal(formatDuration(90), '1m 30s');
    assert.equal(formatDuration(45), '45s');
    assert.equal(formatDuration(3_600), '1h');
    assert.equal(formatDuration(5_400), '1h 30m');
    assert.equal(formatDuration(90_000), '1d 1h');
    assert.equal(formatDuration(0), '0s');
  });

  it('floors negatives and reports missing input', () => {
    assert.equal(formatDuration(-5), '0s');
    assert.equal(formatDuration(null), 'n/a');
    assert.equal(formatDuration(undefined), 'n/a');
  });
});

describe('formatWindow', () => {
  it('picks the largest exact unit', () => {
    assert.equal(formatWindow(2_592_000), '30d');
    assert.equal(formatWindow(86_400), '1d');
    assert.equal(formatWindow(21_600), '6h');
    assert.equal(formatWindow(300), '5m');
    assert.equal(formatWindow(30), '30s');
  });

  it('falls back to seconds when nothing divides evenly', () => {
    assert.equal(formatWindow(90), '90s');
  });
});

describe('formatTimestamp and formatDate', () => {
  it('renders ISO-8601', () => {
    assert.equal(formatTimestamp(0), '1970-01-01T00:00:00Z');
    assert.equal(formatDate(0), '1970-01-01');
  });

  it('reports missing input as n/a', () => {
    assert.equal(formatTimestamp(null), 'n/a');
    assert.equal(formatDate(undefined), 'n/a');
  });
});

describe('formatCount', () => {
  it('abbreviates large numbers', () => {
    assert.equal(formatCount(999), '999');
    assert.equal(formatCount(1_500), '1.5k');
    assert.equal(formatCount(1_234_567), '1.23M');
    assert.equal(formatCount(2_500_000_000), '2.5G');
  });

  it('keeps small fractions', () => {
    assert.equal(formatCount(1.5), '1.5');
    assert.equal(formatCount(0), '0');
  });
});

describe('pad', () => {
  it('pads on the right to the requested width', () => {
    assert.equal(pad('ab', 4), 'ab  ');
    assert.equal(pad('abcdef', 4), 'abcdef');
  });
});
