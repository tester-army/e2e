# Running tests

## Commands

```bash
npx e2e run [files...] [options]   # run tests
npx e2e explore [goal] [options]   # explore the app toward a goal, no test file (see the explore topic)
npx e2e list [files...] [options]  # print what run would select, without running
npx e2e init [--yes]               # scaffold a project, refresh the agent skill
npx e2e guide [topic]              # print this skill: setup, writing-tests, agent, running, explore, debugging, mcp
npx e2e cache ls|clear|stats       # read or empty the trace cache
npx e2e mcp [--target <name>]      # serve the project to a coding agent over MCP (topic mcp)
npx e2e telemetry [disable|enable] # anonymous usage telemetry: status, or the switch
```

`run` flags:

| Flag | Effect |
| --- | --- |
| `[files...]` | Files, directories, or quoted globs relative to the project root, or a bare file name (`signup.e2e.ts`, `signup`, `agent/signup.e2e.ts` all select `tests/agent/signup.e2e.ts`). `file:line` (`tests/signup.e2e.ts:12`) selects the one test whose `test(` call opens on that line. They narrow the config `tests` glob, never bypass it. |
| `--config <path>` | Explicit config file. Default: `e2e.config.ts` or `.mts` found upward from the working directory. |
| `--target <ids>` | Target names, comma-separated or repeated. Only selected targets start app commands and services; unknown names fail before startup. |
| `--tag <tags>` | Tag filter, comma-separated or repeated: any of the tags, or every one with `--tag-mode all`. An empty `--target`, `--tag`, or `--agent` value is a usage error, exit 2. |
| `--exclude-tag <tags>` | Leave out tests carrying any of these tags, whatever else selected them. |
| `--grep <pattern>`, `--grep-invert <pattern>` | Keep, or leave out, tests whose title matches a regular expression: the describe titles and the test title joined by spaces (`checkout pays`), not the file or the tags. Bare pattern, or `'/pattern/i'` for flags; repeat for alternatives. |
| `--last-failed` | Only the tests the previous run did not pass, read from `.e2e/report.json`. No report is `NO_LAST_RUN`, exit 2: run once without the flag first. |
| `--shard <index/total>` | One contiguous slice of the selected tests (`--shard 2/3`), cut after every other filter; serial groups stay together and each shard brings its own setup tests. Same command per CI job with a different index. |
| `--headed` | Visible browser or simulator when the engine supports it. |
| `--agent <names>` | Run unpinned tests as other configured agents (`agents.<name>`), comma-separated or repeated; several names run each such test once per agent. Default is `agents.default`. |
| `--workers <n>`, `--retries <n>` | Override the resolved values. |
| `--max-failures <n>` | Stop once this many tests failed: the rest are skipped with cause `failure-limit`, running tests end as `interrupted`, exit 1. |
| `--reporter <ids>` | `list`, `json`, `junit`, `markdown`, comma-separated. `json` cannot combine with `list`. |
| `--artifacts <dir>` | Artifact root, default `.e2e/artifacts`. |
| `--no-cache` | Run with the trace cache off. |
| `--pass-with-no-tests` | Exit 0 when nothing matches instead of `NO_TESTS`. |
| `--debug` | Phase timings and an agent step table on stderr; step transcripts saved as artifacts. |
| `--ai-trace` | Record every model call to `.e2e/ai-trace.json`. |
| `--video` | Record every attempt (WebM on a browser engine, MP4 on a device engine) under its artifact directory; the failure recap names the file. Fails with `UNSUPPORTED_ARTIFACT` when the engine cannot record. |

```bash
npx e2e run tests/signup.e2e.ts
npx e2e run signup.e2e.ts   # the same file by name, from any directory the config globs cover
npx e2e run tests/signup.e2e.ts:12   # the one test declared at line 12
npx e2e run tests/agent --tag smoke
npx e2e run --tag smoke --exclude-tag slow --grep checkout
npx e2e run --last-failed   # the loop after a red run
npx e2e run --shard 2/3     # one CI job of three
npx e2e run 'tests/**/*.smoke.e2e.ts' --target chromium --workers 1 --retries 0
CI=1 npx e2e run            # reproduce the CI defaults locally
```

`list` takes the same files and the selection flags (`--config`, `--target`,
`--tag`, `--tag-mode`, `--exclude-tag`, `--grep`, `--grep-invert`,
`--last-failed`, `--shard`, `--pass-with-no-tests`) and prints one line per
test-target pair, `file › title [target] #tag`, then exits without starting the
app, an engine, or a worker. `--reporter json` prints `{ "pairs": [...] }`.
Use it to check a filter before a run.

```bash
npx e2e list --tag smoke
npx e2e list tests/signup.e2e.ts --reporter json
```

A `package.json` script keeps it short: `"test:e2e": "e2e run"`, then
`pnpm test:e2e tests/signup.e2e.ts`. pnpm forwards a `--` separator literally,
so `pnpm test:e2e -- --headed` reaches e2e as `run -- --headed` and is
rejected with exit 2 rather than run headless; write `pnpm test:e2e --headed`
or `pnpm exec e2e run --headed` instead.

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
  summary (`Test Files`, `Tests`, `AI`, `Cache` when the trace cache was on: agent steps `replayed` whole, `handed off` to the model part-way, or `missed`, `Start at`, `Duration`, `Report`); setup steps (a first-run browser download, each service and app command) print above the tests and stay out of `Duration` or are split out of it as `(startup …)`.
- `.e2e/report.json` is written on every run whatever the reporters:
  `run.status`, `run.exitCode`, `run.errors[]` (run-level failures such as
  `APP_UNREACHABLE`), and `run.results[]`, one per test and target, with
  `titlePath`, `file`, `source`, `tags` (`[]` when the test declares none), `status`, and `attempts[]` holding `steps[]`,
  `artifacts[]`, and `error`.
- `junit`: `.e2e/junit.xml` beside the report, for CI test summaries.
  Combine it with the terminal output: `--reporter list,junit`.
- `markdown`: `.e2e/summary.md` beside the report: the counts and what the
  run spent, a block per failed test with its error and its facts
  (expected and observed, what a locator asked for), the step it went wrong
  at, whether every attempt failed alike, the last model turns, the screen's
  location and closest nodes, the line to look at, evidence paths; the flaky
  tests folded with the same block each; every test folded by file with the
  file's counts; or an exploration's findings and assessment. Plus one page per
  failed or flaky test under `.e2e/failures/`, with every step, every kept
  turn, and the screen at failure inline. Read the page first; paste the
  summary into a pull request or a handoff rather than retelling the result:
  `--reporter list,markdown`.
- `json`: the report document on stdout.
- Custom reporters receive step progress with `identity` containing
  `attemptId`, `attemptIndex`, `stepId`, and `stepIndex`. The IDs match the
  report and the indexes start at zero. Retries change attempt identity;
  serial members share the group's attempt but keep distinct step IDs.
  The `end` phase carries the redacted error and preserves `blocked` and
  `cancelled` statuses. Accept missing identity when reading older streams.
- `github()` from `@e2edev/github`: on GitHub Actions, one pull request comment per
  run (edited on rerun) and the job summary; needs `pull-requests: write` and
  `GITHUB_TOKEN` in the step's env.
- Artifacts (screenshots, Playwright traces, `--video` recordings, `--debug`
  transcripts, downloads) live under `.e2e/artifacts/`; every path is
  recorded in the report.

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
      - run: npx e2e run --reporter list,junit
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
- Agent steps run in the same job as everything else. Pass the key the
  config's model reads (`AI_GATEWAY_API_KEY` for `gateway()` from `ai`) as
  a secret in the run step's `env`, and commit `.e2e/cache/` so recorded
  steps replay in CI with no model call.
