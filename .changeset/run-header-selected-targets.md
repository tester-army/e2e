---
"e2e": patch
---

When `--target` selects configured targets, the run header and the `run-started` event's `targets` name those targets in config order instead of every configured target. Without `--target`, or with an unknown target ID, they still name every configured target. The report's `run.targets` still lists every configured target.
