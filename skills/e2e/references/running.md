# Running tests

## Commands

```bash
npx --no-install e2e run [files...] [options]   # run tests
npx --no-install e2e list [files...] [options]  # print what run would select, without running
npx --no-install e2e init [--yes]               # scaffold a project, refresh the agent skill
npx --no-install e2e guide [topic]              # print this skill: setup, writing-tests, agent, running, debugging
npx --no-install e2e cache ls|clear|stats       # read or empty the trace cache
```

`run` flags:

| Flag | Effect |
| --- | --- |
| `[files...]` | Files, directories, or quoted globs relative to the project root. They narrow the config `tests` glob, never bypass it. |
| `--config <path>` | Explicit config file. Default: `e2e.config.ts` or `.mts` found upward from the working directory. |
| `--target <ids>` | Comma-separated target names. Only selected targets start app commands and services; unknown names fail before startup. |
| `--tag <tag>` | Repeatable tag filter; `--tag-mode all` requires every tag. |
| `--headed` | Visible browser or simulator when the engine supports it. |
| `--workers <n>`, `--retries <n>` | Override the resolved values. |
| `--reporter <ids>` | `list`, `json`, `junit`, comma-separated. `json` cannot combine with `list`. |
| `--artifacts <dir>` | Artifact root, default `.e2e/artifacts`. |
| `--no-cache` | Run with the trace cache off. |
| `--pass-with-no-tests` | Exit 0 when nothing matches instead of `NO_TESTS`. |
| `--debug` | Phase timings and an agent step table on stderr; step transcripts saved as artifacts. |
| `--ai-trace` | Record every model call to `.e2e/ai-trace.json`. |

```bash
npx --no-install e2e run tests/signup.e2e.ts
npx --no-install e2e run tests/agent --tag smoke
npx --no-install e2e run 'tests/**/*.smoke.e2e.ts' --target chromium --workers 1 --retries 0
CI=1 npx --no-install e2e run   # reproduce the CI defaults locally
```

`list` takes the same files and the selection flags (`--config`, `--target`,
`--tag`, `--tag-mode`, `--pass-with-no-tests`) and prints one line per
test-target pair, `file › title [target]`, then exits without starting the
app, an engine, or a worker. `--reporter json` prints `{ "pairs": [...] }`.
Use it to check a filter before a run.

```bash
npx --no-install e2e list --tag smoke
npx --no-install e2e list tests/signup.e2e.ts --reporter json
```

A `package.json` script keeps it short: `"test:e2e": "e2e run"`, then
`pnpm test:e2e tests/signup.e2e.ts`.

## The trace cache

Entries live under `.e2e/cache/`, one file per key, named after the key
digest. `cache` commands read the same config as `run`, so `--config` and
`cache.dir` point them at the right store.

| Command | Prints |
| --- | --- |
| `e2e cache ls` | One row per entry: test, target, instruction digest, age, action count. |
| `e2e cache stats` | Directory, entry count, total size. |
| `e2e cache clear` | Deletes the entries and the directory; files the runner never wrote stay. |

Use `ls` to see what a committed cache would replay, and `clear` when a
recorded flow is stale — `--no-cache` only skips the cache for one run.

## Output

- `list` (default): one line per file and target, a `Failed Tests` section
  with each error, its code, the failing line and a code frame, then a
  summary (`Test Files`, `Tests`, `AI`, `Start at`, `Duration`, `Report`); setup steps (a first-run browser download, each service and app command) print above the tests and stay out of `Duration` or are split out of it as `(startup …)`.
- `.e2e/report.json` is written on every run whatever the reporters:
  `run.status`, `run.exitCode`, `run.errors[]` (run-level failures such as
  `APP_UNREACHABLE`), and `run.results[]`, one per test and target, with
  `titlePath`, `file`, `source`, `status`, and `attempts[]` holding `steps[]`,
  `artifacts[]`, and `error`.
- `junit`: `.e2e/junit.xml` beside the report, for CI test summaries.
  Combine it with the terminal output: `--reporter list,junit`.
- `json`: the report document on stdout.
- Artifacts (screenshots, Playwright traces, `--debug` transcripts,
  downloads) live under `.e2e/artifacts/`; every path is recorded in the
  report.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Every selected test passed, was flaky, or was skipped |
| 1 | A test or setup test failed or timed out |
| 2 | CLI, config, collection, credential, model-config, or policy error |
| 3 | Engine, app process, model provider, artifact, or cleanup failure |
| 4 | Internal runner error |
| 130 | Interrupted |

The highest code present wins for a mixed run (`130 > 4 > 3 > 2 > 1 > 0`).
Do not retry a job on exit 2: it is deterministic. Exit 3 is the only one
where a job-level retry makes sense.

Ctrl-C once interrupts and still writes the report; twice forces teardown;
three times exits at once.

## Continuous integration

CI mode is on when `CI` is set (and not `0` or `false`). It changes
`retries` to 1, `workers` to 1, rejects `test.only` with `ONLY_IN_CI`, makes
the trace cache `read-only`, and ignores `reuseExisting`.

```yaml
# .github/workflows/e2e.yml
name: e2e
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: pnpm/action-setup@9fd676a19091d4595eefd76e4bd31c97133911f1 # v4.2.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 26
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: npx playwright install chromium --with-deps
      - run: npx --no-install e2e run --reporter list,junit
        env:
          E2E_USER_ADMIN_USERNAME: ${{ secrets.E2E_USER_ADMIN_USERNAME }}
          E2E_USER_ADMIN_PASSWORD: ${{ secrets.E2E_USER_ADMIN_PASSWORD }}
      - if: ${{ !cancelled() }}
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: e2e-report
          path: |
            .e2e/report.json
            .e2e/junit.xml
      - if: failure()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: e2e-artifacts
          path: .e2e/artifacts
          retention-days: 7
```

- Install browsers as their own step so the download never counts against a
  launch timeout.
- Start the app through the engine's `command`; the runner tears it down on
  every exit path.
- Agentic suites: a separate config, run on `schedule` or
  `workflow_dispatch`, `E2E_MODEL` as a CI variable and `E2E_MODEL_API_KEY`
  as a secret, never a required check.
