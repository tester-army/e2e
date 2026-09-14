---
"e2e": patch
---

The CLI starts without the optional `ai` peer dependency. The MCP bridge imported `asSchema` from `ai` statically and every command loads that module, so `npx e2e --help`, and `e2e init` in a project that has not installed `ai` yet, crashed with `ERR_MODULE_NOT_FOUND` before reading a flag. The bridge now reaches the SDK through the same lazy loader as the agent, and an MCP session opened in a project without `ai` reports `MODEL_UNAVAILABLE` instead.
