# Usage

## Contents

- [Install](#install)
- [Command line](#command-line)
- [SLO spec file](#slo-spec-file)
- [Metrics input](#metrics-input)
- [Exit codes](#exit-codes)
- [Library](#library)
- [Recipes](#recipes)
- [Troubleshooting](#troubleshooting)

## Install

```bash
npm install -g burnscope
```

Node.js 20.11 or later. No runtime dependencies.

From a checkout:

```bash
npm ci
npm run build
node dist/cli.js --help
```

`npm test`, `npm run demo` and `npm run demo:quick` compile what they need
automatically.

## Command line

```console
$ burnscope --help
burnscope 1.0.0 — SLO burn-rate and error-budget explorer

Usage
  burnscope analyze --slo <spec.json> --input <metrics> [options]
  burnscope parse --input <metrics> [--input-format prom|csv|json]
  burnscope rules [--profile <id>]
  burnscope explain
  burnscope --version | --help
...
```

### analyze

```bash
burnscope analyze --slo slo.json --input metrics.prom
burnscope analyze -slo slo.json -i metrics.prom -f markdown -o report.md
burnscope analyze --slo slo.json -i metrics.prom -f html -o report.html
burnscope analyze --slo slo.json -i metrics.prom --as-of 2026-01-11T00:00:00Z
burnscope analyze --slo slo.json -i metrics.prom --min-coverage 0.8
burnscope analyze --slo slo.json -i metrics.prom --strict
burnscope analyze --slo slo.json -i metrics.prom --fail-on-firing --fail-on-exhausted
```

| Flag | Meaning |
| ---- | ------- |
| `--slo <file>` | SLO spec (JSON). Required. |
| `-i, --input <file>` | Metrics file. Required. |
| `--input-format <fmt>` | `prom`, `csv` or `json`; inferred from the extension otherwise (`.csv` → csv, `.json` → json, anything else → prom). |
| `--as-of <when>` | Analysis instant: ISO-8601, epoch seconds or epoch ms. Default: newest sample in the input. |
| `--profile <id>` | Alert rule set. Default `google-sre`, or the spec file's `alertProfile`. |
| `--min-coverage <0-1]` | Share of a window that must be covered before its rate is trusted. Default `0.5`. |
| `-f, --format <fmt>` | `text` (`txt`), `markdown` (`md`), `json`, `html`. Default `text`. |
| `-o, --out <file>` | Write the report to a file (directories are created); a confirmation goes to stderr. |
| `--strict` | Fail on the first malformed input line instead of skipping it. |
| `--fail-on-firing` | Exit 3 if any rule is firing. |
| `--fail-on-exhausted` | Exit 3 if any budget is exhausted. |

Both `--fail-on-*` gates are evaluated after the report is produced, so you
still get the document when the gate trips.

### parse

What is in a metrics file, before any SLO claims are made of it:

```console
$ burnscope parse --input examples/metrics.prom
file        examples/metrics.prom
format      prometheus
series      2
samples     482
from        2025-12-31T23:00:00.000Z
to          2026-01-11T00:00:00.000Z

series
  requests_total{code="200",job="api"}  241 samples  from 2025-12-31T23:00:00.000Z to 2026-01-11T00:00:00.000Z
  requests_total{code="500",job="api"}  241 samples  from 2025-12-31T23:00:00.000Z to 2026-01-11T00:00:00.000Z
```

With skipped lines present, their counts and reasons are listed by frequency.
Up to 40 series are printed. Takes the same `--input-format` and `--strict`
flags as `analyze`.

### rules

The alert rule set, with the reasoning behind each threshold:

```console
$ burnscope rules
Google SRE workbook (google-sre)
Four severity-tiered rules: two fast page-worthy burns and two slower ticket-worthy burns, each gated on a long and a short window agreeing.
Reference period: 30d

A rule fires only when BOTH its long and its short window reach the burn-rate threshold.

fast-burn-page  [page]
  long window   1h  (threshold 14.4x)
  short window  5m  (must also reach 14.4x)
  budget used   2.00% of the 30d budget by the end of the long window
  for a 30d period this rule is designed to burn 2.00%
  action        Page the on-call: at this rate 2% of the budget is gone in one hour.
...
```

`burnscope rules -f json` prints the profile as JSON (for other tools);
`--profile <id>` selects a different rule set.

### explain

The arithmetic itself — burn rate, window consumption, the projection, and the
data-quality policy — printed as prose. No inputs needed:

```bash
burnscope explain
```

## SLO spec file

A JSON object with a non-empty `slos` array:

```json
{
  "slos": [
    {
      "name": "checkout",
      "description": "Checkout API availability.",
      "objective": 0.999,
      "period": "30d",
      "periodStart": "2026-01-01T00:00:00Z",
      "metric": "requests_total",
      "good": { "matchers": { "code": "=~2.." } },
      "bad": { "matchers": { "code": "=~5.." } }
    }
  ],
  "alertProfile": "google-sre"
}
```

| Field | Required | Meaning |
| ----- | -------- | ------- |
| `name` | yes | Unique SLO name (duplicates are refused). |
| `description` | no | Free text, shown in reports. |
| `objective` | yes | Availability target strictly between 0 and 1. |
| `period` or `periodSeconds` | one | Window length: duration string (`30d`, `1d12h`, `6h`, `90s`, `4w`) or seconds. Not both. |
| `periodStart` | no | Fixed window start: ISO-8601, epoch seconds or epoch ms. Omit for a rolling window ending at the analysis instant. |
| `metric`, `good`, `bad` | all three or none | Prometheus selectors (see below). Must all be present together. |
| `alertProfile` | no (root) | Rule set id, default `google-sre`. Root `profile` is accepted as an alias. |

Selector values are exact strings (`"200"`) or Prometheus-style anchored
regular expressions prefixed with `=~` (`"=~2.."` becomes `^2..$`). Both
`{ "matchers": { ... } }` and the flat `{ "code": "=~2.." }` forms are
accepted.

Tabular input carries pre-split good/bad columns, so its SLOs must **not**
declare `metric`/`good`/`bad` — and may serve exactly one SLO.

## Metrics input

**Prometheus text exposition** (`.prom`, `.txt`, or `--input-format prom`):

```
# HELP requests_total Total requests, split by response class.
# TYPE requests_total counter
requests_total{code="200",job="api"} 998500 1767225600000
requests_total{code="500",job="api"} 1500 1767225600000
```

- `name{labels} value [timestamp]`; timestamp is epoch ms or seconds —
  missing timestamps are skipped with a reason.
- Blank lines, comments and metadata lines are ignored.
- Malformed lines are skipped (reason retained) unless `--strict`.
- The same series and timestamp written twice: the later write wins when the
  lines are adjacent.
- A file with parseable structure but no samples at all is an error; a file
  with samples plus some bad lines is accepted, with the bad lines reported.

**Tabular** (`timestamp,good,bad`):

```csv
timestamp,good,bad
1767225600000,998500,1500
1767254400000,997000,3000
```

or the same rows as a JSON array (`[{"timestamp": ..., "good": ..., "bad": ...}]`).
Timestamps accept epoch ms/s or ISO-8601. One good/bad pair per file, so one
SLO.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | success |
| 1 | usage error — unknown flag, missing required argument, unknown command/format |
| 2 | input or spec error — parse failure, empty document, invalid spec |
| 3 | a `--fail-on-firing` or `--fail-on-exhausted` gate tripped (the report was still produced) |

## Library

Everything is exported from the package root:

```ts
import {
  parsePrometheus, parseTabular, parseSpec, parseDuration,
  analyze, renderText, renderMarkdown, renderJson, renderHtml,
  windowRate, budgetStatus, evaluateAlerts, getProfile,
  formatBurn, formatPercent,
  VERSION,
} from 'burnscope';
import type { Analysis, SloSpec, WindowRate, AlertProfile } from 'burnscope';
```

Full pipeline:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { analyze, parsePrometheus, parseSpec, renderHtml } from 'burnscope';

const spec = parseSpec(readFileSync('slo.json', 'utf8'));
const document = parsePrometheus(readFileSync('metrics.prom', 'utf8'));

const analysis = analyze({
  slos: spec.slos,
  document,
  // asOf: Date.parse('2026-01-11T00:00:00Z'),   // default: newest sample
  // minCoverage: 0.5,                            // default
  // profile: getProfile(spec.profileId),         // the CLI does this
});

for (const slo of analysis.slos) {
  console.log(slo.spec.name, slo.budget.state, slo.firing.map((a) => a.rule.id));
}
writeFileSync('report.html', renderHtml(analysis));
```

Each stage is also usable on its own:

```ts
import { getProfile, windowRate, budgetStatus, evaluateAlerts } from 'burnscope';

const profile = getProfile('google-sre');
const rate = windowRate({
  label: 'long', windowSeconds: 3600, asOf,
  good, bad, budgetRatio: 0.001, periodSeconds: 2_592_000, minCoverage: 0.5,
});
const ledger = budgetStatus({
  objective: 0.999, periodSeconds: 2_592_000,
  periodStart, asOf, periodBurnRate: rate.burnRate, periodSufficient: rate.sufficient,
});
```

Errors: `SpecError`, `ParseError` and `UsageError` extend `BurnscopeError`;
catch `BurnscopeError` for "the input was refused", let anything else
through — those are bugs.

## Recipes

**CI gate — fail the pipeline when the budget is gone or rules fire:**

```bash
burnscope analyze --slo slo.json -i metrics.prom --fail-on-firing --fail-on-exhausted
```

**Nightly report for the team channel:**

```bash
burnscope analyze --slo slo.json -i metrics.prom -f markdown -o "burn-$(date +%F).md"
```

**One HTML file to attach to an incident review:**

```bash
burnscope analyze --slo slo.json -i metrics.prom -f html -o incident.html
```

No external requests are made when it opens — the chart is inline SVG.

**Check what a scrape export actually contains:**

```bash
burnscope parse -i metrics.prom
```

**Score yesterday, not "now":**

```bash
burnscope analyze --slo slo.json -i metrics.prom --as-of 2026-01-10T00:00:00Z
```

**Pre-split counters from your own aggregator:**

```bash
burnscope analyze --slo slo.json -i counters.csv --input-format csv
```

## Troubleshooting

**`cannot analyze: the input contains no timestamped samples`**
Every line was skipped or none carried a timestamp. Run `burnscope parse -i
<file>` to see the skip reasons, or drop `--strict` if you passed it.

**`window ... not evaluated` / burn rate shows `0x`**
The window is less covered than `--min-coverage` (default 50% of its length)
by samples. Lower `--min-coverage` to accept thinner data, or export at a
scrape interval that fits your shortest window (a 5m short window wants
samples at least every ~2.5m).

**`periodStart is after the analysis instant; the SLO window was clamped`**
Your fixed `periodStart` is newer than `--as-of`/the newest sample. Either the
file predates the window or the date is mistyped; the analysis proceeds with a
zero-length elapsed window and says so.

**`tabular input holds a single good/bad pair, so it can serve exactly one SLO`**
CSV/JSON input has no labels, so it cannot serve multiple labelled SLOs.
Export Prometheus exposition, or analyze the SLOs one file at a time.

**A rule I expected to fire reads `clear`**
Both windows must reach the threshold. Check the `GOT` column: it shows
`long/short`; a healed short window keeps the rule quiet by design.

**HTML report opens but shows no chart**
Almost certainly an empty period (no samples inside the SLO window). The
report still renders the numbers; check the data-quality notes.
