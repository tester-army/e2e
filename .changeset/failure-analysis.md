---
"e2e": minor
---

Post-run failure analysis, opt-in. With `analysis` configured or `--analyze`
passed, each failed, timed-out, or flaky test gets one bounded
model call after its last attempt that says what went wrong, why, who should
look at it (`app-bug`, `test-bug`, `environment`, `flaky`, `unknown`), and
what to do about it, with a suggested locator when the screen shows the
control the test missed. The verdict prints under the failure in the list
reporter, streams as an `analysis` run event, lands in report.json as the
result's `e2edev.analysis` extension, and joins the markdown summary the GitHub
comment renders from. Analysis is read-only and post-hoc: never a status, never a test
budget, never a run failure, never part of the config digest.

Three seams make it the project's own: `analysis.instructions` adds project
knowledge to the built-in analyzer's policy, `analysis.evidence` adds
providers whose text joins every analysis (the diff under test, a server log,
an error tracker), and `analysis.analyzer` replaces the analyzer wholesale.
