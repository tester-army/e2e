---
'e2e': patch
---

`e2e mcp` opens a session in a project without the optional `ai` package. The catalog and argument checks read each tool's Standard Schema when the AI SDK is not installed, so a deterministic-only project (no `agents`, `e2e init` with no model gateway) can `open_session`, `observe`, `locate`, and drive the page; only a model-backed call still needs `ai`.
