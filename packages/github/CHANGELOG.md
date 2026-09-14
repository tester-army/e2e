# @e2edev/github

## 0.3.0

### Minor Changes

- [#294](https://github.com/tester-army/e2e/pull/294) [`c2c5df7`](https://github.com/tester-army/e2e/commit/c2c5df7df94b25a8284b69dd6bc00a459b770a59) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The runner is published as `e2e`. `@e2edev/e2e` is retired and deprecated on npm; every import, config, and peer range now names `e2e` (`e2e`, `e2e/agent`, `e2e/engine`). The engines and the GitHub reporter declare their peer dependency on `e2e`, so a project on `@e2edev/e2e` must switch the runner to `e2e` when it takes these versions. The CLI keeps its `e2e` bin name.

### Patch Changes

- [#293](https://github.com/tester-army/e2e/pull/293) [`e301105`](https://github.com/tester-army/e2e/commit/e3011054080237f6141419f738a680574308765b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Publishes as a public package, like the rest of the `@e2edev` scope.

## 0.2.0

### Minor Changes

- [#284](https://github.com/tester-army/e2e/pull/284) [`8811ba7`](https://github.com/tester-army/e2e/commit/8811ba7de97b239f8d1a32fb0785ff00d7f0011e) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A built-in `markdown` reporter writes the run as one markdown page,
  `.e2e/summary.md` beside `report.json`, laid out for a pull request: a
  headline with the counts and, when the agent ran, what the run spent (agent
  steps, cache replays, model calls, tokens, cost); run-level errors; one block
  per test that failed or was flaky with its error, the step it went wrong at,
  the agent's own explanation of what it saw, the attempt's step timeline, and
  the paths of its evidence from the project root; a table with one row per
  test file; and every test folded away, grouped by file. An `e2e explore` run
  renders its record instead: the goal and steps, every finding with what was
  expected, what the screen showed, the actions that reach it, and its
  screenshot, then the assessment. It is the text a coding agent pastes into a
  pull request or a handoff instead of retelling the result.
  `renderMarkdownReport(report, { artifactsUrl, artifactsDir, sourceUrl })` is
  exported from the main entrypoint for a reporter that posts the page
  elsewhere. `@e2edev/github` posts this page as the pull request comment in
  place of its one table of tests that did not pass; its `renderComment`,
  `CommentOptions`, `MAX_MARKER_CHARS`, and `MAX_URL_CHARS` exports are gone
  (nothing consumed them), and the package now needs `@e2edev/e2e` 0.13 or
  later. `e2e init` ignores `.e2e/summary.md`.

## 0.1.0

### Minor Changes

- [#246](https://github.com/tester-army/e2e/pull/246) [`a0a4df0`](https://github.com/tester-army/e2e/commit/a0a4df01b463dd6117d44e0844a81880f7a4abdb) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The GitHub reporter. `reporters: ['list', github()]` posts one pull request
  comment per run from GitHub Actions and keeps it current across reruns: the
  counts, the run-level errors, one row per test that did not simply pass with
  its error and the evidence it left, the passed tests folded away, links to
  each test's source at the PR head and to the workflow run where the artifacts
  are. The same text goes to the job summary, pull request or not. It reads
  `GITHUB_TOKEN` (or `GH_TOKEN`) and the event when the run finishes; `key`
  tells matrix replicas' comments apart. Off
  GitHub Actions, on a push, or without a token it posts nothing and says so in
  one summary row. `renderComment` is exported so another host can render the
  same comment from a report-1 document.
