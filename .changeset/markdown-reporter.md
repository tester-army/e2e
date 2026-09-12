---
'@e2edev/e2e': minor
'@e2edev/github': patch
---

A built-in `markdown` reporter writes the run as one markdown page,
`.e2e/summary.md` beside `report.json`: a headline with the counts, run-level
errors, a table of every test that did not simply pass with its error and the
paths of its evidence from the project root, and the passed tests folded away.
An `e2e explore` run renders its record instead: the goal and steps, every
finding with what was expected, what the screen showed, the actions that reach
it, and its screenshot, then the assessment. It is the text a coding agent
pastes into a pull request or a handoff instead of retelling the result.
`renderMarkdownReport(report, options)` is exported from the main entrypoint
for a reporter that posts the page elsewhere. `@e2edev/github` renders its
pull request comment from it, so the comment gains the exploration section;
its `renderComment` export is the same function under the older name, and the
package now needs `@e2edev/e2e` 0.13 or later. `e2e init` ignores
`.e2e/summary.md`.
