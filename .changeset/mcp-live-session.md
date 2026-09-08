---
"@e2edev/e2e": minor
---

`e2e mcp` opens a live session on one target for the coding agent:
`open_session` starts the declared app command, boots the engine, and
returns the first observation; the testing agent's own tools follow
(`observe`, `tap`, `type`, `press`, `select`, `scroll`, `navigate`,
`type_secret`, and the project's `defineTool` values), plus `locate` to try a
semantic locator before writing it, a masked `screenshot`, and
`close_session`. Sessions enforce the same origin, secret, and pixel policy
as tests, close on idle, and never outlive the client; `run_tests` closes an
open session first. `--target` fixes the target and `--headless` hides the
UI. `createAgent` now returns its `tools`, so a host can serve them.
