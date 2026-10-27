---
"e2e": patch
---

`e2e mcp` sessions have a `run_code` tool. Pass it test statements as a test body writes them, such as `await screen.getByLabel('Email').fill('ada@example.com')`, and the session runs them on its `screen` and `app` with a test's waits and matchers. It stops at the first failure and returns each statement's result, then what changed on screen. The statements that pass, except reads, join the `test_lines` draft. A project tool named `run_code` now fails the config load with `INVALID_CONFIG`. The bundled skill tells the coding agent to run the lines no action printed, such as assertions, with `run_code` before it writes them into the test.
