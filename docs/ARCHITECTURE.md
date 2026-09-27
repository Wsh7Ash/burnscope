# Architecture

## Contents

- [Shape](#shape)
- [The pipeline](#the-pipeline)
- [Modules](#modules)
- [Data model](#data-model)
- [Key decisions](#key-decisions)
- [Compiling and testing](#compiling-and-testing)

## Shape

burnscope is a library with a CLI on top. `src/cli.ts` parses arguments,
reads files, and hands plain values to `analyze()`; every report the CLI can
print is `renderX(analysis)` on the same `Analysis` object the library
returns. There is no state between calls — two runs over the same bytes produce
byte-identical output.

```
src/
  cli.ts              argument parsing, exit codes, file I/O
  scope.ts            analyze(): the pipeline, end to end
  spec.ts             SLO spec file -> SloSpec[]
  select.ts           label matchers -> merged good/bad counters
  series.ts           window rates: increase, coverage, counter resets
  budget.ts           budget ledger: consumed, remaining, exhaustion
  mwmb.ts             alert profiles and rule evaluation
  parse/
    prometheus.ts     text exposition -> MetricsDocument
    tabular.ts        CSV/JSON good,bad rows -> TabularDocument
  report/
    text.ts           terminal report
    markdown.ts       markdown report
    json.ts           JSON serialization of Analysis
    html.ts           self-contained HTML + inline SVG chart
  format.ts           percent/burn/duration/timestamp formatting
  errors.ts           BurnscopeError > SpecError | ParseError | UsageError
  types.ts            the public data model
  index.ts            the public API surface
```

## The pipeline

`analyze()` in `src/scope.ts` runs five stages:

```
spec file ──parseSpec──> SloSpec[] ─────────────┐
                                                 ├─> analyze() ──> Analysis
metrics file ──parse*──> MetricsDocument ────────┘
```

1. **Resolve the analysis instant.** `asOf` defaults to the newest sample, so
   output is reproducible; an empty document is a hard error.
2. **Gather series per SLO** (`collectSloSeries`). Prometheus input: match
   `metric` plus the `good`/`bad` label matchers, then merge matched series
   into one good counter and one bad counter (summed per timestamp). Tabular
   input is already split and skips this stage — which also means it can serve
   exactly one SLO.
3. **Score the period window** (`windowRate`). The window is the *elapsed*
   part of the SLO window: its nominal length is `elapsedSeconds`, so consuming
   budget in 3 of 30 days is scored as 3 days, not 30. Output: good/bad
   increases, error rate, burn rate, coverage, sufficiency.
4. **Ledger and alerts.** `budgetStatus()` turns the period burn rate into
   consumed/remaining/projected/exhaustion and the four-state label;
   `evaluateAlerts()` runs every profile rule's long and short windows through
   the same `windowRate()` and fires when both reach the threshold.
5. **Narrative and curve.** `buildObservations()` writes the plain-language
   lines; `intervalRates()` produces the per-sample burn-rate curve the HTML
   chart draws.

## Modules

| Module | Does | Knows nothing about |
| ------ | ---- | ------------------- |
| `parse/prometheus` | exposition text → series, skipped lines | SLOs, burn rates |
| `parse/tabular` | CSV/JSON rows → good/bad counters | labels, selectors |
| `spec` | spec JSON → validated `SloSpec[]` | metrics input |
| `select` | matchers → merged counters | windows, budgets |
| `series` | samples + window → rate | alert rules, reports |
| `budget` | rate + window geometry → ledger | metrics, alerts |
| `mwmb` | profile rules → firing/clear | rendering, files |
| `scope` | orchestration, observations | CLI flags, formatting |
| `report/*` | `Analysis` → string | parsing, file I/O |
| `cli` | argv → exit code | algorithms |

Dependencies point downward: `report` and `cli` sit on `scope`, which sits on
the primitives; nothing below `scope` imports upward. The parsers and
primitives are usable standalone through `index.ts`.

## Data model

Everything crosses module boundaries as plain immutable data (`readonly`
interfaces in `types.ts`), with epoch-millisecond timestamps:

- `MetricsDocument`: `series[]`, `skipped[]`, `sampleCount`, first/last
  timestamps, `format`.
- `SloSpec`: validated spec — `objective`, `periodSeconds`, optional raw
  `periodStart`, optional `metric`/`good`/`bad`.
- `WindowRate`: one measured window — nominal vs observed seconds, coverage,
  increases, error rate, burn rate, `sufficient` + `note`.
- `BudgetStatus`: the ledger — consumed, remaining, projection, exhaustion
  instants, `state`.
- `AlertEvaluation`: rule + its two `WindowRate`s + `firing`/`evaluated`.
- `Analysis`: asOf, profile, `slos[]`, skipped lines, data-quality notes.

Renderers take `Analysis` and nothing else, which is why the same object can
feed text, markdown, JSON and HTML without re-running anything.

## Key decisions

**Withheld rather than extrapolated.** A window covering less than
`minCoverage` reports no burn rate. Prometheus extrapolates to window edges;
burnscope reports observed seconds and coverage instead, because a confident
number from a truncated span is worse than an honest gap. Alert rules in that
state read *not evaluated*, never *clear*.

**Consecutive-line duplicate collapse.** When the Prometheus parser meets two
writes to the same series and timestamp, the later one replaces the earlier —
but only when the lines are adjacent. A duplicate separated by other lines is a
different signal (someone re-sent old data after a gap) and is kept as two
samples. This keeps `m 1 T` / garbage / `m 2 T` visible as two samples while
back-to-back writes still collapse.

**Strict failures at the document edge, leniency inside.** A file with no
samples in it at all is an error (there is nothing to analyze, and pretending
otherwise would produce an all-zero report). A file with samples that also has
a malformed line is accepted: the line is skipped, its reason is retained, and
it surfaces as a data-quality note. `--strict` promotes any bad line to a
failure.

**Raw `periodStart` until analysis.** The spec layer validates that
`periodStart` is an instant but keeps it exactly as written (epoch seconds,
epoch milliseconds or ISO-8601); `resolvePeriodStart` normalizes to epoch ms
where the arithmetic runs. Users see their own spelling in errors; arithmetic
never sees a string.

**Errors are a hierarchy.** `UsageError` (exit 1) for bad flags,
`SpecError`/`ParseError` (exit 2, both extending `BurnscopeError`) for input
the tool refuses, anything else is a bug and propagates as a stack trace. The
CLI never converts an unexpected exception into "input error".

**The demo asserts.** `demo/demo.ts` builds a deterministic incident (ten days
at 1.5x, last hour at 20x), runs the full pipeline, and exits non-zero if any
expected state, rule verdict, serialization, or report shape differs — a
regression in budget math fails the build, not just the unit tests.

## Compiling and testing

Two TypeScript projects:

- `tsconfig.json` → `dist/`: the publishable library and `dist/cli.js`
  (executable, shebang, `bin` entry).
- `tsconfig.test.json` → `dist-test/`: the same sources plus `tests/` and
  `demo/`, for `node --test`.

`npm test` runs `pretest` (compile) then
`node --test dist-test/tests/*.test.js`. The glob is unquoted in package.json
on purpose: cmd.exe cannot expand globs, so Windows passes the pattern through
to Node (which expands it), while sh on CI expands it before Node sees it —
both paths work. `npm run demo` / `demo:quick` likewise compile first via
`predemo`.

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck`,
`npm run build`, `npm test`, `npm run demo` on Node 20.x, 22.x and 24.x.
