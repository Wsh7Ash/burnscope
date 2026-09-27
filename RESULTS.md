# Results

Measured on 2026-09-27 with Node v24.13.0 / npm 11.6.2 on Windows, from the
repository root. Every command below was run as written; the outputs quoted
here are copied verbatim (or trimmed only where marked). Raw artifacts live in
`results/` (6 files, 77,203 bytes total).

## Verification

| Command | Result |
| ------- | ------ |
| `npm run typecheck` | clean — both `tsconfig.json` and `tsconfig.test.json` |
| `npm run build` | clean — `dist/` library + CLI |
| `npm test` | **216/216 pass**, 0 fail (43 suites, 11 files) |
| `npm run demo` | `demo: ok`, exit 0 |
| `npm run demo:quick` | `demo (quick): ok`, exit 0 |
| `npm run verify` | passes (typecheck + test + demo) |

## Test suite

Per-file counts (`node --test dist-test/tests/<file>`):

| File | Tests | Pass |
| ---- | ----- | ---- |
| budget.test | 18 | 18 |
| format.test | 17 | 17 |
| mwmb.test | 13 | 13 |
| package.test | 15 | 15 |
| prometheus.test | 22 | 22 |
| report.test | 24 | 24 |
| scope.test | 20 | 20 |
| select.test | 19 | 19 |
| series.test | 21 | 21 |
| spec.test | 23 | 23 |
| tabular.test | 24 | 24 |
| **total** | **216** | **216** |

The suite is the specification: it pins parser leniency and refusals line by
line, the exact budget projections (`864000`, `345600`, `432000` seconds to
exhaustion for the hand-computed cases), the Workbook's 2%/5%/10% rule
consumption figures, coverage withholding, and agreement between all four
report renderers.

## CLI exit codes

Probed against the committed examples:

```console
$ burnscope analyze --slo examples/slo.json -i examples/metrics.prom --version
1.0.0                              -> exit 0

$ burnscope analyze --slo examples/slo.json -i examples/metrics.prom --bogus
burnscope: --bogus ...             -> exit 1 (usage)

$ burnscope analyze --slo examples/slo.json -i <file with no samples>
burnscope: cannot analyze: ...     -> exit 2 (input)

$ burnscope analyze --slo examples/slo.json -i examples/metrics.prom --fail-on-firing -f json
burnscope: alert rules are firing  -> exit 3 (gate), report still written
```

## Demo scenario (npm run demo)

Deterministic incident: ten days at 1.5x burn, the final hour at 20x, hourly
samples (2,880 curve points), fixed window starting 2026-01-01. The demo
asserts every figure below and exits non-zero on any mismatch.

```
checkout  [BURNING]
  objective    99.90% (budget 0.100%)
  error rate   0.156%
  burn rate    1.56x
  window       10d of 30d elapsed (33.33%)
  budget       51.93% used, 48.07% left
  exhaustion   2026-01-20T06:11:11.614Z (in 9d 6h)

  RULE                  SEV     LONG   SHORT  NEED    GOT           STATUS
  fast-burn-page        page    1h     5m     14.4x   15.37x/20x    FIRING
  medium-burn-page      page    6h     30m    6x      3.81x/20x     clear
  slow-burn-ticket      ticket  1d     2h     3x      2.08x/8.44x   clear
  long-burn-ticket      ticket  3d     6h     1x      1.69x/3.81x   FIRING
```

- 51.93% of the budget consumed at 33.33% of the window — on pace to exhaust
  with 9d 6h of runway left.
- 2 of 4 rules firing: the fast page (15.37x long, 20x short, both over
  14.4x) and the long ticket (1.69x/3.81x, both over 1x).
- The medium page stays quiet: its long window (6h) averages down to 3.81x
  below the 6x threshold, though the short window alone would qualify —
  exactly the disagreement the two-window design exists to catch.
- Report sizes for the full analysis: text 1,114 B, markdown 1,779 B,
  JSON 588,991 B, HTML 16,024 B.

`npm run demo:quick` (12 hours at 2x) ends with `state: burning — 3% of the
budget consumed`, zero rules firing, and the 1d/3d windows reported as
**not evaluated** — the coverage gate refusing to score windows the data
cannot support.

## Example scenario (examples/, results/)

`examples/slo.json` + `examples/metrics.prom`: 10 days of hourly counters on a
fixed 30d window, baseline 1.5x with a 20x final hour. 482 samples, 2 series
(241 each), 2025-12-31T23:00Z → 2026-01-11T00:00Z.

| Measure | Value |
| ------- | ----- |
| Period burn rate | 1.58x (error rate 0.158%) |
| Budget consumed | 52.57% after 33.33% of the window |
| Remaining | 47.43% |
| Projected exhaustion | 2026-01-20T00:32:20.290Z — in 9d 32m |
| Rules firing | fast-burn-page (20x/20x), long-burn-ticket (1.76x/4.58x) |
| Rules clear | medium-burn-page (4.58x/20x), slow-burn-ticket (2.27x/10.75x) |

Regenerate every artifact:

```bash
burnscope analyze --slo examples/slo.json --input examples/metrics.prom -f text    -o results/report.txt
burnscope analyze --slo examples/slo.json --input examples/metrics.prom -f markdown -o results/report.md
burnscope analyze --slo examples/slo.json --input examples/metrics.prom -f json     -o results/report.json
burnscope analyze --slo examples/slo.json --input examples/metrics.prom -f html     -o results/report.html
burnscope rules  > results/rules.txt
burnscope parse --input examples/metrics.prom > results/parse.txt
```

| Artifact | Bytes |
| -------- | ----- |
| results/report.txt | 1,116 |
| results/report.md | 1,784 |
| results/report.json | 61,008 |
| results/report.html | 11,356 |
| results/rules.txt | 1,548 |
| results/parse.txt | 391 |
| **total** | **77,203** |

The HTML report is self-contained: inline SVG chart, no `<script>`, `<link>`,
`<img>` or `<iframe>` references, no network requests when opened. The JSON
report carries the full analysis: budget ledger, every window's coverage and
increases, both alert evaluations, data-quality notes and the burn curve.
