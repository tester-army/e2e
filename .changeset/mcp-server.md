---
"@e2edev/e2e": minor
---

`e2e mcp` serves the project's live app to a coding agent over the Model
Context Protocol on stdio. `open_session` starts the declared app command,
boots the engine, and returns the first observation; the testing agent's
own tools follow (`observe`, `tap`, `type`, `press`, `select`, `scroll`,
`navigate`, `type_secret`, and the project's `defineTool` values), plus
`locate` to try a semantic locator before writing it, a masked
`screenshot`, and `close_session`. Sessions enforce the same origin,
secret, and pixel policy as tests, close on idle, and never outlive the
client. The agent skill is served as resources. `e2e init` registers the
server in `.mcp.json` and `.cursor/mcp.json`, `e2e guide mcp` prints the
new skill topic, and `createAgent` now returns its `tools` so a host can
serve them.
