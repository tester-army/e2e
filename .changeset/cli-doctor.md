---
"e2e": patch
---

Add `e2e doctor`: checks that `e2e run` can start without starting anything. It covers the Node.js runtime, the config and its targets, each engine's own checks, and the model each agent resolved to. `--reporter json` prints the `doctor-1` report for a host, `--check-model` calls each model once, and the command exits 2 when a check failed. Engines can report their checks through the new optional `doctor` hook.
