---
'@e2edev/e2e': minor
'@e2edev/github': minor
---

A built-in `markdown` reporter writes the run as one markdown page,
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
