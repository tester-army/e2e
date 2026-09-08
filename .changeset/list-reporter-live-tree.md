---
"@e2edev/e2e": patch
---

The list reporter prints each file, test, and agent step exactly once. The
live window carries the in-progress tree - running tests with their finished
steps, the current step's model turns and tool calls in causal order, and an
animated `Thinking` indicator - at a fixed height so the summary stays put; the
file block prints once the file completes, with agent steps nested under their
test; on a TTY a file that ran agent steps lists its tests even when it passed,
so the scrollback keeps them. The `RUN` banner names the configured model. Model events record
`inputTokens` and `outputTokens` beside `count`, and `run-started` carries the
configured `model`, both additive. The window repaints every 80ms instead of
200ms so the indicator animates.
