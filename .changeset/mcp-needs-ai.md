---
'e2e': patch
---

`e2e init` adds `ai` and `zod` when it registers the MCP server, even with the model gateway set to None: `e2e mcp` reads its tools' schemas through the AI SDK, so a deterministic-only project scaffolded with the server could not open a session. Without `ai`, `open_session` now says that an MCP session needs the package even with no model configured, instead of blaming model-backed agent calls the session never made. The error code stays `MODEL_UNAVAILABLE`.
