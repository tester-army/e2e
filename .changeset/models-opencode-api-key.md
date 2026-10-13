---
"e2e": patch
---

`e2e models opencode-console` uses `OPENCODE_API_KEY` to request the model list when it is set; listing requires the key to have access to `/console/api/config`. This is the key `opencodeConsole()` reads in place of the stored login, and `e2e models` with no provider includes OpenCode Console when only the key is set. Without either, the error names both `npx e2e login opencode-console` and `OPENCODE_API_KEY`.
