---
'e2e': minor
---

The public surface loses exports nothing outside the runner consumed: `BLOCKABLE_CODES`, `RUNTIME_CODES`, `buildTraceEntry`, and `readTraceEntry` from `e2e`, `isDefinedTool` and `toolAppliesTo` from `e2e/agent`, and the `store`, `apiUrl`, and `baseURL` options of `chatgpt()`, `copilot()`, and `grok()`, whose option types are gone with them. A `blocked` verdict still names a code from the table in the agent-steps guide, a custom `TraceCacheStore` still handles entries opaquely, and the constructors take only a model id; a login comes from `e2e login` or `E2E_OAUTH_CREDENTIALS`.
