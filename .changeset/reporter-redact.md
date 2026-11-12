---
"e2e": patch
---

A reporter's `onRunFinished` gets `run.redact(text)`, which masks the config's secret values the way a test filter's `redact` does, for text it adds from outside the report, such as lines of a test file.
