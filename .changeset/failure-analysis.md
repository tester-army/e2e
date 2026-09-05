---
'@e2edev/e2e': minor
---

Post-failure analysis. A test failure now leaves the final screen behind: the
moment it lands, with the session still open, the runner captures a masked
screenshot (when `screenshot` is among the artifact kinds) and the redacted
accessibility tree as a `log` artifact, both attached to the failing step.
With `analysis` configured — or `--analyze` — each failed test then gets one
bounded model call after its last attempt that classifies the failure
(`app-bug`, `test-bug`, `environment`, `flaky`, `unknown`) with a confidence,
a two-sentence summary, the evidence behind it, and a suggested fix. The
verdict streams as an `analysis` run event, prints under the failure in the
list reporter, and lands in `report.json` as the result's `e2edev.analysis`
extension. Analysis is read-only and post-hoc: it never changes a status,
spends a test's model budget, or fails the run; a missing verdict is recorded
as `unavailable` with a reason. Hosts can replace the built-in analyzer with a
`FailureAnalyzer` of their own.
