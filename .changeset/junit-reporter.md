---
"@e2edev/e2e": minor
---

Add a `junit` reporter. Selected with `reporters: ['junit']` or `--reporter junit`, it renders the run's `report-1` document as JUnit XML and atomically writes `.e2e/junit.xml` beside `report.json`, on every outcome where the report is written: one `<testsuite>` per test file, one `<testcase>` per test-target pair, `<failure>` for test-category errors, `<error>` for infrastructure and configuration errors, `<skipped>` with the reason, and a `run` suite carrying run-level errors such as `APP_UNREACHABLE`. It combines with `list` or `json`. `RunOutcome` and the `run-finished` event carry `junitPath`, the list reporter prints it, and `e2e init` gitignores the file.
