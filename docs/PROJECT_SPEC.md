# burnscope

## 1. Problem

An SLO is a promise about how much failure a service may afford. The promise is
measured over a window — thirty days — but failure is paid for continuously:
every hour at a bad rate spends budget that cannot be replaced until the window
rolls over. Teams routinely declare a 99.9% objective and then discover,
somewhere inside the window, that the budget is gone and nobody was paged while
it happened.

The arithmetic is not hard, but doing it correctly is easy to get subtly wrong.
Burn rate is not the error rate: it is the error rate divided by the budget
ratio, so a 99.9% objective turns a 1.58% error rate into a 15.8x burn. A
budget projection needs the elapsed fraction of the window, not the wall clock.
A single measurement window cannot distinguish a sustained regression from a
blip that has already healed, which is why the Google SRE Workbook pairs a long
window with a short one and requires both to agree.

burnscope exists to do that arithmetic in one place, honestly, with the data
quality of every number stated rather than assumed.

## 2. Goals

1. **Correct.** Burn rate, budget consumed, and exhaustion projection follow the
   published definitions exactly; the fast-burn threshold of a 30d period
   evaluates to 2% consumed, as the Workbook's table says. Verified by tests
   against hand-computed values.
2. **Multi-window, multi-burn-rate alerting.** The four rules of the Google SRE
   Workbook (chapter 5, Table 4) — two page-worthy fast burns, two ticket-worthy
   slower ones — each firing only when its long window *and* its short window
   reach the threshold.
3. **Honest about data.** A window that is less covered than
   `--min-coverage` (default 50%) is reported as *not evaluated* with the
   reason attached; its burn rate is withheld rather than extrapolated. Skipped
   input lines are retained and surfaced as data-quality notes, never silently
   dropped.
4. **Reproducible.** The analysis instant defaults to the newest sample in the
   input, so the same file always produces the same report. No hidden clock.
5. **Everywhere you need it.** One command for a terminal, a file or a CI gate;
   one library call for a dashboard or a scheduled job. Four report formats:
   text, markdown, JSON, and a fully self-contained HTML page with the
   burn-rate chart inline.
6. **Dependency-free.** Runtime and tests use only Node's standard library and
   TypeScript. `npm ci && npm test` is the whole setup.

## 3. Non-goals

- **A metrics store or query engine.** burnscope reads a file you already
  exported — Prometheus text exposition, or pre-split good/bad counters as
  CSV/JSON. It does not scrape, query, or store anything.
- **A dashboard server.** The HTML report is a file; hosting it is your
  business. It makes no network requests.
- **Alert delivery.** burnscope says which rules *would* fire. Routing pages
  and tickets is a job for your alertmanager.
- **A general PromQL implementation.** Matchers are exact values or anchored
  `=~` regular expressions over labels — enough to pick good and bad series out
  of an exposition file, not a query language.
- **Composite or multi-objective SLOs.** One SLO scores one error budget.
  Composition (availability *and* latency counting together) is deliberately
  out of scope for 1.0.

## 4. Constraints

- Node.js 20.11 or later; no runtime dependencies; TypeScript in strict mode.
- Two compilation targets: `tsconfig.json` builds the distributable `dist/`
  (the CLI and the library), `tsconfig.test.json` builds tests and the demo
  into `dist-test/`.
- Timestamps are epoch milliseconds everywhere in the API; ISO-8601 strings
  only appear in rendered reports.
- The test suite is the specification: a behavior is defined by a test, and
  parser leniency changes are made in the parser, never by editing an
  expectation.
- Exit codes are stable API: 0 success, 1 usage, 2 input/spec error, 3 a
  `--fail-on-*` gate tripped.

## 5. Design

### 5.1 Burn rate

For an objective `o`, the budget ratio is `b = 1 - o`. Over any window, the
error rate `e = bad / (good + bad)` gives

```
burn rate = e / b
```

`1x` is exactly sustainable — the budget would last the whole window. `14.4x`
is the fast-burn threshold: a 30-day budget gone in about two hours.

### 5.2 Budget and projection

The window's share of the period budget is `burn * (window / period)`, which is
where the Workbook's 2% figure for the 1h fast-burn window comes from:
`14.4 * (1h / 720h) = 2%`.

Budget used so far is `burn * elapsedFraction`, where the elapsed fraction runs
from `periodStart` (explicit in the spec, or `asOf - period` for a rolling
window) to the analysis instant. Exhaustion is the instant `used` reaches 1,
i.e. one burn-rate multiple through the window; if the current rate is already
spent (`used >= 1`) the projection reports 0 runway rather than a date in the
future.

### 5.3 Coverage, not extrapolation

A window's rate is computed from the samples inside it. If the samples cover
less than `minCoverage` of the window's length, the rate is marked
insufficient: burn rate is reported as `0x`/withheld, alert rules say *not
evaluated*, and a note explains what was observed. Prometheus-style
extrapolation to the window edges is deliberately not performed — the observed
span and coverage are reported instead so the reader can judge.

Counter resets are read the way Prometheus reads them: a decrease between
samples is a restart from zero, and the post-reset value contributes to the
increase.

### 5.4 Alerting

Each rule has a long window, a short window, and a threshold. The rule fires
only when *both* windows reach the threshold — the long window proves a real
regression, the short window proves it has not healed. Rules:

| Rule | Severity | Long | Short | Burn threshold |
| ---- | -------- | ---- | ----- | -------------- |
| fast-burn-page | page | 1h | 5m | 14.4x |
| medium-burn-page | page | 6h | 30m | 6x |
| slow-burn-ticket | ticket | 1d | 2h | 3x |
| long-burn-ticket | ticket | 3d | 6h | 1x |

### 5.5 Input

Prometheus text exposition: `name{labels} value timestamp` per line, comments
and `# HELP`/`# TYPE` ignored, malformed lines skipped with their reason
retained (or rejected immediately under `--strict`). Tabular input is
`timestamp,good,bad` as CSV or a JSON array — already split, so it serves
exactly one SLO.

## 6. Acceptance

- `npm run typecheck`, `npm test`, `npm run demo` and `npm run verify` all
  pass on Node 20, 22 and 24 (CI runs this matrix).
- The example scenario in `examples/` produces the report shown in the README,
  with `fast-burn-page` and `long-burn-ticket` firing.
- Every documented number in RESULTS.md is reproducible from a committed
  command; raw outputs live in `results/`.
