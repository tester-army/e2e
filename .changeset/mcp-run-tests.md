---
"e2e": patch
---

`e2e mcp` has a `run_tests` tool: it runs a test file, one test (`tests/checkout.e2e.ts:12`), or the whole suite as `e2e run` does and returns what the run printed, so a coding agent can run tests without a shell.

```txt
run_tests {files: ["tests/checkout.e2e.ts:12"]}
```
