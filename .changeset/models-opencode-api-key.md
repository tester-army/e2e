---
"e2e": patch
---

`e2e models opencode-console` lists the ids through `OPENCODE_API_KEY` when it is set, the key `opencodeConsole()` reads in place of the stored login, and `e2e models` with no provider includes OpenCode Console when only the key is set. Without either, the error names both `npx e2e login opencode-console` and `OPENCODE_API_KEY`.
