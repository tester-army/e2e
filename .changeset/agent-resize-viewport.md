---
"e2e": patch
---

The built-in agent can resize the viewport with the new `resize_viewport` tool, so `agent.act` and `e2e explore` can check layouts at desktop, tablet, and phone widths. The tool is offered when the target's engine implements the new optional `session.resize` hook. Custom executors call `ctx.actions.resize({ width, height })`, and the replay cache records and replays it.
