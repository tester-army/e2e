# 06 — CLI

Binary name: `e2e` (via `npx e2e …`).

## DX guarantees

The Vitest bar, adopted wholesale:

- **TS + ESM native.** Test files are TypeScript/ESM and just run — no
  Babel, no transform config, no `tsconfig` ceremony. There is no
  `transform` key anywhere in e2e.
- **Zero to first green run in minutes.** `npx e2e init && npx e2e run`
  works with only `APP_URL` set: browsers are provisioned automatically on
  first run (no separate install step), the example test passes, artifacts
  land in `.e2e/`.
- **No API key required for the deterministic tier.** Suites using only
  `screen`/`web`/`expect` run fully offline. `agent.*` calls without a
  configured model fail upfront with a clear setup message — never
  mid-suite.
- **Migrating means deleting config, not porting it.** A Playwright
  project adopting e2e should end up with *less* configuration than it
  started with.

## Commands

### `e2e init`

Scaffold in an existing project:

- creates `e2e.config.ts` (minimal, commented)
- creates `tests/example.e2e.ts` (the signup happy path)
- adds `.gitignore` entries for artifacts
- prints next steps (`npx e2e run`)

### `e2e run [files…]`

Run tests locally (or in Cloud with `--cloud`).

```bash
npx e2e run
npx e2e run tests/signup.e2e.ts
npx e2e run --tag smoke
npx e2e run --cloud
```

| Flag | Meaning |
|---|---|
| `--cloud` | force `runner: 'cloud'` |
| `--target <names>` | run only these targets, e.g. `--target ios` or `--target web,android` |
| `--tag <tag>` | filter by test tags |
| `--headed` | run with visible browser |
| `--retries <n>` | override retries |
| `--workers <n>` | override parallelism |
| `--reporter <list\|json>` | output format |
| `--artifacts <dir>` | artifact output dir (default `.e2e/artifacts`) |
| `--no-agent-cache` | ignore cached agent action paths, force fresh reasoning |

Behavior: boots `app.command` if configured, runs tests, writes artifacts
(including the HTML step-timeline report), exits non-zero on failure.

### Post-v0 commands

`e2e dev` (watch mode), `e2e open` (report/inspector UI), `e2e credentials`
(encrypted local store), and `e2e login` (Cloud auth; `TESTERARMY_TOKEN` env
covers CI) are deliberately not in the v0 core — see roadmap/.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | all tests passed |
| 1 | test failures |
| 2 | configuration/environment error (bad config, missing credentials) |
| 3 | infrastructure error (browser/device/cloud unavailable) |

## Output principles

- Default reporter is a clean live list (Vitest-style), agent steps rendered
  as an indented narrative under each test.
- Failures print: agent's explanation, last screenshot path, artifact dir,
  and the path to the HTML step-timeline report.
