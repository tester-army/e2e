---
"e2e": patch
---

Add `test.fail` to mark a test that is expected to fail: `test.fail(title, fn)`, `test.fail(condition, reason)` inside a body, or the `fail` test option. A marked test that fails with a test failure passes, and the report keeps the reason and the original error under `expectedFailure`. A marked test that passes fails with `UNEXPECTED_PASS`, so a fixed gap gets noticed. Infrastructure errors such as `ENGINE_FAILURE` and blocked agent verdicts are not covered.
