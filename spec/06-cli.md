# 06 — CLI

Binary name: `e2e` (via `npx e2e …`).

## Commands

### `e2e init`

Scaffold in an existing project:

- creates `e2e.config.ts` (minimal, commented)
- creates `tests/example.e2e.ts` (the signup happy path)
- adds `.gitignore` entries for artifacts
- prints next steps (`npx e2e run`)

Flags: `--template <basic|email-signup>`.

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
| `--reporter <list\|json\|github>` | output format |
| `--artifacts <dir>` | artifact output dir (default `.e2e/artifacts`) |
| `--no-agent-cache` | ignore cached agent action paths, force fresh reasoning |
| `--shard <n/total>` | deterministic sharding for CI matrices (see 11-lifecycle.md) |

Behavior: boots `app.command` if configured, runs tests, writes artifacts,
exits non-zero on failure.

### `e2e dev`

Watch mode — the local authoring loop (see 11-lifecycle.md): headed browser,
sessions kept alive between runs, re-runs affected tests on file change,
warm agent path cache.

```bash
npx e2e dev
npx e2e dev tests/checkout.e2e.ts
```

### `e2e open`

Open the local report/inspector UI for the last run: timeline of agent
steps, screenshots, traces, and resource events (emails, webhook
deliveries) correlated with app actions.

```bash
npx e2e open
npx e2e open --run <id>
```

In Cloud mode, prints the hosted replay URL instead.

### `e2e credentials`

Manage the encrypted local credential store:

```bash
npx e2e credentials set admin
npx e2e credentials list
npx e2e credentials rm admin
```

### `e2e login` / `e2e logout`

Authenticate the CLI with TesterArmy Cloud (device flow). `TESTERARMY_TOKEN`
env always wins over stored login (CI-friendly).

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
  and a copy-pasteable `npx e2e open` hint.
- `--reporter github` emits workflow annotations.
