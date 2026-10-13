---
"e2e": patch
---

`e2e models opencode-console` lists models through `OPENCODE_API_KEY` when it is set, the key `opencodeConsole()` uses in place of the stored login. `e2e models` with no provider includes OpenCode Console when only the key is set, and with no credential the error names both `npx e2e login opencode-console` and `OPENCODE_API_KEY`.
