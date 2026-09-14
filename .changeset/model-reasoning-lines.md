---
'e2e': minor
---

A finished model turn in the live window now appends an excerpt of the
model's reasoning when the model produced one: `• Thinking (2.84s) (↑7.5k
↓18) · The modal blocks checkout; closing it first`. Runs and explorations
alike show why the agent acted, not just that it did. The excerpt collapses
to one line and clips to the terminal; the full reasoning stays in the AI
trace (`--ai-trace`). The same bounded excerpt lands on the report's `model`
step events as `reasoning` (report-1 schema), and custom executors report
their own through `recordModelCall({ reasoning })`.
