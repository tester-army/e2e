---
"@e2edev/e2e": minor
---

`e2e mcp` serves a project's live app to a coding agent over the Model
Context Protocol on stdio, through four fixed tools in the style of
executor.sh: `open_session` loads a config (the nearest one, or the path
the call names), starts the declared app command, boots the engine, and
returns the session's catalog and first observation; `call` runs any
catalog tool by name (`observe`, `tap`, `type`, `press`, `select`,
`scroll`, `navigate`, `type_secret`, `locate` to try a semantic locator
before writing it, a masked `screenshot`, and the project's `defineTool`
values), validating its arguments against the tool's own schema; `tools`
describes the catalog; `close_session` ends it. The client's tool list
never changes, so one server covers every project and config the agent
opens without a restart. Sessions enforce the same origin, secret, and
pixel policy as tests, close on idle, and never outlive the client. The
agent skill is served as resources. `e2e init` registers the server in
`.mcp.json` and `.cursor/mcp.json`, `e2e guide mcp` prints the new skill
topic, and `createAgent` now returns its `tools` so a host can serve them.
