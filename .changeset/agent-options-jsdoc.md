---
'e2e': patch
---

The JSDoc of the agent call options names the current defaults: `assert`, `waitFor`, and `extract` default to the agent's `judgmentTimeout`, `act` to `config.timeout`, and the budgets to `agents.<name>.maxSteps` and `agents.<name>.maxModelCalls`. `CacheMode` says CI demotes only an unset mode without a custom store to `read-only`.
