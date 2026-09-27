# burnscope

SLO burn-rate and error-budget explorer: multi-window multi-burn-rate alerting,
budget exhaustion projection, and self-contained burn reports from
Prometheus-style metrics.

Tell burnscope where your error budget is and how your counters are recorded,
and it tells you how fast you are spending the budget, when it runs out, and
which of the Google SRE workbook alert rules would be firing right now — as a
terminal report, a markdown summary, a JSON document, or a standalone HTML page
with a burn-rate chart.

```console
$ burnscope analyze --slo examples/slo.json --input examples/metrics.prom
burnscope
  analysed at  2026-01-11T00:00:00Z
  profile      Google SRE workbook (google-sre)
  min coverage 50%

checkout  [BURNING]
  Checkout API availability.
  objective    99.90% (budget 0.100%)
  error rate   0.158%
  burn rate    1.58x
  window       10d of 30d elapsed (33.33%)
  budget       52.57% used, 47.43% left
  exhaustion   2026-01-20T00:32:20.290Z (in 9d 32m)

  RULE                  SEV     LONG   SHORT  NEED    GOT           STATUS
  fast-burn-page        page    1h     5m     14.4x   20x/20x       FIRING
  medium-burn-page      page    6h     30m    6x      4.58x/20x     clear
  slow-burn-ticket      ticket  1d     2h     3x      2.27x/10.75x  clear
  long-burn-ticket      ticket  3d     6h     1x      1.76x/4.58x   FIRING

  - Error rate 0.158% against a 99.90% objective (budget 0.1%).
  - Burn rate over the SLO window is 1.58x (faster than sustainable).
  - 52.57% of the budget consumed after 33.33% of the window has elapsed; 47.43% remaining.
  - Projected exhaustion in 9d 32m at the current rate.
  - 2 of 4 rules firing (1 page and 1 ticket): fast-burn-page, long-burn-ticket
```

No runtime dependencies, standard library of Node.js only, Node 20.11+.

## Install

```bash
npm install -g burnscope
```

Or from a checkout:

```bash
npm ci
npm run build          # dist/
node dist/cli.js --help
```

## Command line

```bash
burnscope analyze --slo slo.json --input metrics.prom            # text report
burnscope analyze --slo slo.json --input metrics.prom -f html -o report.html
burnscope analyze --slo slo.json --input metrics.prom --fail-on-firing
burnscope parse --input metrics.prom                             # what's in the file
burnscope rules                                                  # the alert rules
burnscope explain                                                # the arithmetic
```

Metrics input can be Prometheus text exposition, `timestamp,good,bad` CSV, or a
JSON array of the same rows — inferred from the file extension, or forced with
`--input-format`. Reports come in `text`, `markdown`, `json` and `html`; the
HTML report is fully self-contained (inline SVG, no external requests).

Exit codes are distinct so a script can tell the failures apart:

| Code | Meaning |
| ---- | ------- |
| 0 | success |
| 1 | usage error — bad arguments |
| 2 | input or spec error — parse failure, no samples, bad spec |
| 3 | a `--fail-on-firing` or `--fail-on-exhausted` gate tripped |

## What it computes

```
  counters (Prometheus series, or pre-split CSV/JSON)
      |
  [ select ]    sum the series your good/bad matchers pick out
      |
  [ window ]    increase over each window -> error rate -> burn rate
      |         a window with < min-coverage samples is withheld, not guessed
  [ budget ]    consumed = burn * elapsed fraction; project 1/burn to exhaustion
      |
  [ alerts ]    Google SRE multi-window multi-burn-rate rules:
      |         long window AND short window must both reach the threshold
      |
  [ report ]    text | markdown | json | self-contained HTML with SVG chart
```

A **burn rate** is the error ratio divided by the budget ratio: at a 99.9%
objective the budget ratio is 0.1%, so a measured error rate of 1.58% is
**15.8x** — the budget would last 1/15.8 of the window. `1x` is exactly
sustainable.

A **window** is only scored when enough of it is covered by samples
(`--min-coverage`, default 50%). A three-day rule window with twenty minutes of
data is reported as *not evaluated* with the reason attached, rather than
producing a confident number from a truncated span. Counter resets are read the
way Prometheus reads them: a decrease is a restart from zero.

The four alert rules pair a long window (sensitivity to a sustained regression)
with a short window (evidence the problem has not healed), and fire only when
both reach the threshold — the table from the Google SRE Workbook, chapter 5.

## Example input

`examples/slo.json` declares a 99.9% objective over a fixed 30-day window with
label matchers; `examples/metrics.prom` is ten days of hourly counters running
1.5x over budget with a 20x outage in the final hour. The full report is in
`results/`:

```bash
burnscope analyze --slo examples/slo.json --input examples/metrics.prom -f markdown
burnscope analyze --slo examples/slo.json --input examples/metrics.prom -f html -o results/report.html
```

## Library

```ts
import { parsePrometheus, parseSpec, analyze, renderHtml } from 'burnscope';

const spec = parseSpec(readFileSync('slo.json', 'utf8'));
const document = parsePrometheus(readFileSync('metrics.prom', 'utf8'));
const analysis = analyze({ slos: spec.slos, document });

console.log(analysis.slos[0].budget.state);   // 'burning'
console.log(analysis.slos[0].firing.length);  // rules currently firing
writeFileSync('report.html', renderHtml(analysis));
```

Everything the CLI does is the library with argument parsing on top. The
public API is exported from `src/index.ts`: parsers, spec loader, `analyze`,
the four renderers, the window/budget/alert primitives, and every type.

## Documentation

- [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md) — the problem, the goals, the
  non-goals
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the pipeline, the modules, and
  the decisions behind the numbers
- [docs/USAGE.md](docs/USAGE.md) — every command, flag, and spec field, with
  recipes
- [RESULTS.md](RESULTS.md) — measured results from the test suite and demo

## Development

```bash
npm ci
npm run typecheck      # both tsconfigs
npm test               # 216 tests
npm run demo           # full incident scenario, asserts its own results
npm run demo:quick     # smaller scenario
npm run verify         # typecheck + test + demo
```

Tests are the specification: every parse rule, every refusal, and every number
in a report is pinned by a test. CI runs typecheck, build, tests and the demo
on Node 20, 22 and 24.

## License

MIT. See [LICENSE](LICENSE).
