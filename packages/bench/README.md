# @e2edev/bench

E2E Bench runs the repository's agentic suites across models and releases,
scores every run from its report, and keeps the results. It answers two
questions with the same data: which model is good at agentic testing (the
harness held at one release, the model varied) and whether e2e itself is
getting better (the model held at the reference arm, the release varied).

## Tracks

| Track | Suite | Oracle |
| --- | --- | --- |
| `act` | `packages/web-benchmark/tests-agent` scenarios: one `agent.act` per scenario, then a deterministic check | the test's own expect; declared gaps count as harness coverage, not model failures |
| `judgment` | `packages/web-benchmark/tests-judgment`: `agent.assert` of correct behavior on the 8 planted-bug pages (must fail) and on working pages including the two traps (must pass) | the `bug:` / `clean:` title prefix decides the confusion-matrix cell |
| `explore` | `e2e explore` against the bug garden in `packages/testbed` | regex matcher over the 11 planted defects, plus `adjudications.json` for recurring unplanted findings |
| `explore-clean` | the same exploration against the garden with every defect fixed (`BUG_GARDEN_CLEAN=1`) | every issue is a false positive |

Arms are in `src/catalog.ts`: gateway model ids with tier, list price, and the
reason each is in. Every run has the trace cache off, zero retries, the AI
trace on, and its own app instance on its own port.

## Commands

Build first (`pnpm build` at the root, then the web-benchmark app), then:

```bash
AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/bench bench run --arms luna-fast,gemini-3.8-flash --tracks act,explore --repeats 1 --label smoke
pnpm --filter @e2edev/bench bench run --dry-run              # print every command the matrix would run
pnpm --filter @e2edev/bench bench score .bench/<label>       # rescore a raw matrix (after an adjudication, say)
pnpm --filter @e2edev/bench bench report                     # render the newest summary as Markdown
pnpm bench docs                                              # regenerate docs/benchmark.mdx from results/ (root `check` verifies it)
```

`run` writes raw runs under `.bench/<label>/<arm>/<track>/r<n>/` (report,
AI trace, artifacts, `cli.log`, `run.json`) and the summary under `results/`.
`docs/benchmark.mdx` is rendered from every summary under `results/` by
`bench docs`; edit `src/docs-page.ts`, never the page.

## Scoring

- **Tests** (`act`): pass rate over executed tasks, reliability (the share of
  tasks that passed in every repeat), and a histogram of failure codes, so an
  honest `failed` verdict, `STEP_NO_CONCLUSION`, and `STEP_BUDGET_EXHAUSTED`
  stay apart.
- **Judgment**: caught / missed / false alarm / correct / inconclusive. A
  `bug:` test that fails with `ASSERTION_FAILED` (or `ACTION_FAILED`, the act
  ran into the bug) is a catch; a `clean:` test that fails with
  `ASSERTION_FAILED` is a false alarm; any other failure never reached the
  judgment.
- **Explore**: recall over the planted defects, precision over adjudicated
  findings, false positives, duplicates, stuck runs, time to first finding,
  and the share of findings with a screenshot. Findings nobody has judged
  are printed after the run; add them to `adjudications.json` as
  `false-positive` or `valid-unplanted` and rescore.
- **Cost and speed** on every row: model calls, actions, tokens in and out,
  cache-read share, reasoning tokens (from the AI trace), provider-reported
  cost and the same tokens at list price, wall time, and time inside model
  calls. Compare dollars across vendors, not tokens: tokenizers differ.

## Rules

- Nothing here gates a PR. Every run spends real model calls.
- A model is added by adding an arm; a task is added by adding a test to the
  suite it belongs to and bumping `TASK_SET_VERSION` in `src/tracks.ts`.
  Rows are comparable within one task-set version only.
- Judges stay deterministic. If an expectation cannot be checked with a
  regex or a status code, reconsider the expectation.
