# Contributing

Thanks for considering a contribution. burnscope is small on purpose — the
aim is a readable, dependency-free implementation where every number in a
report can be traced to a test.

## Setup

```bash
npm ci
npm run verify      # typecheck + test + demo
```

Node.js 20.11 or later. No other tooling is required.

## The rules of the road

1. **The test suite is the specification.** A behavior exists when a test says
   it does. Parser leniency or strictness changes are made in the parser, never
   by editing an expectation to match new behavior — if you believe an
   expectation is wrong, say so in the pull request and explain the case it
   misses.
2. **No dependencies.** Runtime and tests use Node's standard library and
   TypeScript only. A contribution that adds a package to `dependencies` or
   `devDependencies` outside of a deliberate, discussed decision will be
   declined.
3. **Numbers need sources.** Any figure that appears in README, docs or
   RESULTS — thresholds, percentages, counts — must be reproducible from a
   committed command, and RESULTS.md must say which command.
4. **Honesty over helpfulness.** If a window is under-covered, the correct
   output is *not evaluated* with a reason, not a plausible-looking number.
   The same goes for skipped input lines: retained and reported, never
   silently dropped.
5. **Two tsconfigs.** `tsconfig.json` builds `dist/` (library + CLI),
   `tsconfig.test.json` builds `dist-test/` (tests + demo). New scripts must
   compile through one of these; keep `npm run typecheck` green for both.

## Making a change

```bash
npm run typecheck
npm test
npm run demo
npm run verify
```

Run all four before opening a pull request; CI runs the same set on Node 20,
22 and 24.

- New behavior: add a test first, in the matching file under `tests/`. The
  existing files mirror the source tree (`parse/prometheus.ts` →
  `prometheus.test.ts`).
- New CLI flags: document them in `docs/USAGE.md` and the `--help` text, and
  give them a stable exit-code story.
- Report format changes: check all four renderers — they consume the same
  `Analysis` and should agree on facts.
- Demo-affecting changes: `demo/demo.ts` asserts its own output; update the
  assertions deliberately, in the same commit as the behavior change.

## Style

- Strict TypeScript; `readonly` on interface members; no `any` in exported
  signatures.
- No comments that restate the code. Comments explain *why* a rule exists or
  why the obvious approach is wrong.
- Errors: throw `UsageError` for bad input to the CLI, `SpecError` for bad
  specs, `ParseError` for unreadable documents — all reachable through
  `BurnscopeError`. Never convert an unexpected exception into a parse error.
- Timestamps are epoch milliseconds everywhere in the API.

## Commits and pull requests

- One logical change per commit; message in the imperative ("withhold
  burn rate below min coverage", not "fixed a bug").
- Pull requests describe *why*, and list the exact commands you ran with
  their results.
- Do not commit build output (`dist/`, `dist-test/`) or editor files;
  `.gitignore` already covers them.
