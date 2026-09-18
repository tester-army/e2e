---
'e2e': patch
---

`console.log` and `console.error` in a test reach the terminal again. Workers wrote them straight into the runner's terminal, where the live window painted over them and left stale rows behind; the worker now sends each write to the runner as an `output` run event, and the list reporter prints it above the live window under a `stdout | target file > test` heading, one heading per source until another line intervenes. A line written in pieces prints once whole, and every secret value the worker has seen is redacted before the text leaves it. Programmatic reporters receive the same event with the test id, agent, target, and stream.
