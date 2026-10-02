---
'e2e': patch
---

`e2e mcp` opens a session in a project without the optional `ai` package. Without the AI SDK, the catalog and the argument checks read each tool's Standard Schema (zod's), so a deterministic-only project (no `agents`, `e2e init` with no model gateway) can `open_session`, `observe`, `locate`, and drive the page.
