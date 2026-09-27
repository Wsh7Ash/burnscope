# Changelog

All notable changes to burnscope are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-09-27

First release.

### Added

- **Analysis pipeline** (`analyze`): per-SLO period scoring, error-budget
  ledger with exhaustion projection, and multi-window multi-burn-rate alert
  evaluation in one call.
- **Alert profiles** (`mwmb`): the Google SRE Workbook rule set —
  `fast-burn-page` (1h/5m at 14.4x), `medium-burn-page` (6h/30m at 6x),
  `slow-burn-ticket` (1d/2h at 3x), `long-burn-ticket` (3d/6h at 1x) — each
  firing only when both windows reach the threshold.
- **Window rates** (`series`): counter increases with Prometheus-style reset
  handling, observed-vs-nominal coverage, and rate withholding below
  `--min-coverage` instead of extrapolation.
- **Budget ledger** (`budget`): consumed/remaining fractions, projected
  remaining at period end, exhaustion timestamp and runway, four-state label
  (`healthy`, `at-risk`, `burning`, `exhausted`).
- **Prometheus parser**: text exposition with label parsing, `# HELP`/`# TYPE`
  and comment handling, per-line skip reasons, adjacent duplicate-write
  collapse, document-level failure when no samples can be read, and `--strict`.
- **Tabular parser**: `timestamp,good,bad` as CSV or JSON, header aliases,
  epoch/ISO timestamps, per-row skip reasons.
- **SLO spec loader**: `objective`, `period`/`periodSeconds` durations
  (`30d`, `1d12h`, `6h`, …), fixed or rolling windows via raw `periodStart`,
  label selectors (`exact` and `=~regex`), root `alertProfile`, full validation
  with precise error paths.
- **Reports**: text (terminal), markdown, JSON and a self-contained HTML page
  with an inline SVG burn-rate chart; no external requests.
- **CLI**: `analyze`, `parse`, `rules`, `explain`; `--as-of`,
  `--min-coverage`, `--input-format`, `--strict`, `-f/-o`,
  `--fail-on-firing`/`--fail-on-exhausted`; stable exit codes 0/1/2/3.
- **Test suite**: 216 tests covering parsers, spec validation, window math,
  budget projections, alert evaluation, selectors, renderers, formatting, the
  demo and the published-package surface.
- **Demo** (`npm run demo`, `npm run demo:quick`): deterministic incident
  scenario that asserts its own expected states and rule verdicts.
- **Documentation**: README, PROJECT_SPEC, ARCHITECTURE, USAGE, RESULTS,
  CONTRIBUTING; CI workflow on Node 20/22/24 running typecheck, build, tests
  and the demo.
