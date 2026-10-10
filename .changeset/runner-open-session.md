---
"e2e": minor
---

Add `openSession()` to `e2e/runner`: open one e2e session from another test runner, with the target's engine, device or browser provisioning, fixtures, live step progress (`onStep`), the step records (`steps()`), and cleanup. It is the same attempt `e2e mcp` opens. `config` takes a path or an `E2EConfig` value, as `list()` does.
