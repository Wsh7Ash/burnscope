import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parsePrometheus } from '../src/parse/prometheus.js';
import { parseTabular } from '../src/parse/tabular.js';
import { formatBurn } from '../src/format.js';
import { decimate, escapeHtml, renderHtml } from '../src/report/html.js';
import { renderJson } from '../src/report/json.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderText } from '../src/report/text.js';
import { analyze } from '../src/scope.js';
import type { Analysis, SloSpec } from '../src/types.js';
import { DAY, MINUTE, STEP_MS, T0, closeTo, csvFrom, sequence, steady } from './_helpers.js';

const BUDGET_RATIO = 0.001;
const ESC = String.fromCharCode(27);
const TEN_DAYS = 10 * DAY;
const BASE_BURN = 1.5;
const SPIKE_BURN = 20;
const SPIKE = 45 * MINUTE;

const SLO: SloSpec = {
  name: 'checkout',
  description: 'Checkout API availability.',
  objective: 0.999,
  periodSeconds: 30 * DAY / 1000,
  periodStart: T0,
};

/**
 * Ten days of a service running 1.5x over budget, ending in a fresh 45-minute
 * incident at 20x. That combination exercises the interesting case: a page is
 * warranted, the month-to-date burn rate is unsustainable, and the budget still
 * has room left.
 */
function fixture(): Analysis {
  const schedule = sequence(
    steady(T0, T0 + TEN_DAYS - SPIKE, STEP_MS, BASE_BURN),
    steady(T0 + TEN_DAYS - SPIKE, T0 + TEN_DAYS, STEP_MS, SPIKE_BURN),
  );
  const document = parseTabular(csvFrom(schedule, BUDGET_RATIO), 'csv');
  return analyze({ slos: [SLO], document });
}

describe('renderText', () => {
  it('names every SLO and its state', () => {
    const text = renderText(fixture());
    assert.match(text, /^burnscope$/m);
    assert.match(text, /checkout {2}\[BURNING\]/);
    assert.match(text, /objective {4}99\.90%/);
    assert.match(text, /fast-burn-page/);
    assert.match(text, /FIRING|clear/);
  });

  it('is free of ANSI escape sequences so it diffs cleanly', () => {
    assert.equal(renderText(fixture()).includes(ESC), false);
  });

  it('ends with exactly one newline', () => {
    const text = renderText(fixture());
    assert.ok(text.endsWith('\n'));
    assert.equal(text.endsWith('\n\n'), false);
  });
});

describe('renderMarkdown', () => {
  it('opens with a summary table of every SLO', () => {
    const md = renderMarkdown(fixture());
    assert.match(md, /^# Burnscope report$/m);
    assert.match(md, /## Summary/);
    assert.match(md, /\| SLO \| Objective \| Burn rate \| Budget used \| Remaining \| State \| Firing \|/);
    assert.match(md, /\| `checkout` \| 99\.90% \|/);
  });

  it('includes the alert table with both windows', () => {
    const md = renderMarkdown(fixture());
    assert.match(md, /### Multi-window multi-burn-rate alerts/);
    assert.match(md, /\| Rule \| Severity \| Long \| Short \| Threshold \| Long burn \| Short burn \| Status \|/);
    assert.match(md, /\| `fast-burn-page` \| page \| 1h \| 5m \| 14\.4x \|/);
    assert.match(md, /\*\*FIRING\*\*/);
  });

  it('reports the projected exhaustion and the observations', () => {
    const md = renderMarkdown(fixture());
    assert.match(md, /### Observations/);
    assert.match(md, /of the budget consumed after/);
  });

  it('never leaves a blank gap where a caveat list would be', () => {
    const md = renderMarkdown(fixture());
    assert.equal(/\n\n\n/.test(md), false);
  });
});

describe('renderJson', () => {
  it('round-trips the analysis through JSON', () => {
    const analysis = fixture();
    const parsed = JSON.parse(renderJson(analysis)) as Analysis;
    assert.equal(parsed.slos.length, 1);
    assert.equal(parsed.slos[0]?.spec.name, 'checkout');
    assert.equal(parsed.asOf, analysis.asOf);
    assert.equal(JSON.stringify(parsed).length > 100, true);
  });

  it('emits no NaN or Infinity, which are not valid JSON', () => {
    const text = renderJson(fixture());
    assert.equal(text.includes('NaN'), false);
    assert.equal(text.includes('Infinity'), false);
  });
});

describe('renderHtml', () => {
  it('produces a complete self-contained document', () => {
    const html = renderHtml(fixture());
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<\/html>\n$/);
  });

  it('makes no external requests', () => {
    const html = renderHtml(fixture());
    assert.equal(/<(script|link|img|iframe)\b/i.test(html), false);
    assert.equal(/https?:\/\//.test(html), false);
  });

  it('draws the burn-rate chart as inline SVG with a log axis', () => {
    const html = renderHtml(fixture());
    assert.match(html, /<svg viewBox="0 0 900 300"/);
    assert.match(html, /role="img"/);
    for (const decade of ['0.001x', '0.01x', '0.1x', '1x', '10x', '100x']) {
      assert.equal(html.includes(`>${decade}</text>`), true, `missing gridline ${decade}`);
    }
    assert.match(html, /<path d="M/);
    assert.match(html, /faster than sustainable/);
  });

  it('shows the budget bar with a width matching the remaining budget', () => {
    const analysis = fixture();
    const html = renderHtml(analysis);
    const remaining = analysis.slos[0]?.budget.remaining ?? 0;
    assert.match(html, new RegExp(`class="budget-left" style="width:${(remaining * 100).toFixed(2)}%"`));
  });

  it('marks firing rows in the alert table', () => {
    const html = renderHtml(fixture());
    assert.match(html, /<tr class="firing">/);
  });

  it('falls back to a message when there is no curve to draw', () => {
    const document = parsePrometheus('m{a="1"} 1 1000\n');
    const html = renderHtml(
      analyze({
        slos: [{ name: 'x', objective: 0.99, periodSeconds: 3600, metric: 'm', good: { matchers: { a: '1' } }, bad: { matchers: { a: '2' } } }],
        document,
      }),
    );
    assert.match(html, /Not enough consecutive samples/);
  });
});

describe('escapeHtml', () => {
  it('neutralises every character that could break out of markup', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
    assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
    assert.equal(escapeHtml("it's"), 'it&#39;s');
  });

  it('keeps hostile label values inert inside the report', () => {
    const schedule = steady(T0, T0 + DAY, 5 * MINUTE, 1);
    const document = parseTabular(csvFrom(schedule, BUDGET_RATIO), 'csv');
    const analysis = analyze({
      slos: [{ ...SLO, name: '<img src=x onerror=alert(1)>', description: '"><script>bad()</script>' }],
      document,
    });
    const html = renderHtml(analysis);
    assert.equal(html.includes('<img src=x'), false);
    assert.equal(html.includes('<script>bad()'), false);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

describe('decimate', () => {
  const points = Array.from({ length: 5000 }, (_, i) => ({
    t: i,
    good: 1,
    bad: 0,
    total: 1,
    errorRate: 0,
    burnRate: i === 2500 ? 99 : 0.1,
  }));

  it('leaves a short curve untouched', () => {
    const short = points.slice(0, 10);
    assert.equal(decimate(short, 100).length, 10);
  });

  it('keeps the result within the budget', () => {
    assert.equal(decimate(points, 100).length <= 100, true);
  });

  it('preserves spikes', () => {
    const reduced = decimate(points, 100);
    closeTo(Math.max(...reduced.map((point) => point.burnRate)), 99, 1e-9);
  });

  it('keeps points in time order', () => {
    const reduced = decimate(points, 100);
    for (let i = 1; i < reduced.length; i += 1) {
      assert.equal((reduced[i]?.t ?? 0) > (reduced[i - 1]?.t ?? 0), true);
    }
  });

  it('rejects an unusable budget', () => {
    assert.throws(() => decimate(points, 2), RangeError);
  });
});

describe('report agreement', () => {
  it('tells the same story in every format', () => {
    const analysis = fixture();
    const slo = analysis.slos[0];
    assert.ok(slo !== undefined);
    assert.equal(slo.budget.state, 'burning');
    assert.ok(slo.firing.some((alert) => alert.rule.id === 'fast-burn-page'));

    for (const body of [renderText(analysis), renderMarkdown(analysis), renderHtml(analysis)]) {
      assert.ok(body.includes('checkout'), 'every renderer must name the SLO');
      assert.ok(body.includes('fast-burn-page'), 'every renderer must name the firing rule');
      assert.ok(body.includes('BURNING'), 'every renderer must state the budget');
    }
  });

  it('agrees on the exact burn rate across renderers', () => {
    const analysis = fixture();
    const burn = analysis.slos[0]?.period.burnRate ?? 0;
    const formatted = formatBurn(burn);
    for (const body of [renderText(analysis), renderMarkdown(analysis), renderHtml(analysis)]) {
      assert.ok(body.includes(formatted), `expected ${formatted} in the report`);
    }
  });
});
