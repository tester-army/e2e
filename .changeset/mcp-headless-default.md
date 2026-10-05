---
"e2e": minor
---

`e2e mcp` sessions are now headless by default, the same as `e2e run` and `e2e explore`, and the agent decides per session: `open_session {headed: true}` shows the browser or simulator, `headed: false` hides it. `--headed` makes headed the default for sessions that do not say. Before, sessions were headed outside CI and only the server's `--headless` could hide them; `--headless` is still accepted, since it now asks for the default, but it is no longer documented.
