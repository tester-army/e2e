---
"e2e": patch
---

Add `--action-timeout <ms>` and `--assertion-timeout <ms>` to `e2e run`. They replace the config's `actionTimeout` and `assertionTimeout` for one run, so a wrong locator can fail in 5 s instead of 30 s while you write a test. A call's own `timeout` still wins, and a value that is not an integer from 1 through 2147483647 is a usage error, exit 2. Watch mode keeps them for every rerun.
