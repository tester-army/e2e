---
'@e2edev/e2e': minor
---

The `list` reporter is laid out like vitest's default reporter. Results print
one block per test file and target - a colored target badge, the file, its
counts, and its duration - with every test listed when the file failed, had a
flaky pass, streamed its steps, or is the run's only file. Failures move to a
`Failed Tests` section at the end, each with its error, the failing line, and
a vitest-style code frame, followed by a padded summary (`Test Files`,
`Tests`, `AI`, `Start at`, `Duration`, `Report`). On a TTY a live window
shows the running files and tests with elapsed times, the current step and
its latest model or engine calls, and the running counters. Colors follow
picocolors' detection, so CI logs are colored too.

For hosts on the event stream, `plan` now carries `files` (reportable pairs
per test file and target) and `test-started` carries the test's `file` and
`serialId`. A serial group announces every member as it begins, not just the
first, and `serial-group` is emitted before its members' `test-finished`
results, so each member's duration, usage, and error can be attributed.
