---
"e2e": patch
---

The agent's `tap`, `double_tap`, and `right_click` tools, in `agent.act` and the MCP server, take an optional `modifiers` list (`Shift`, `Control`, `Alt`, `Meta`, `ControlOrMeta`) on an engine that declares `tapModifiers`, like the test API's `tap({ modifiers })`. The held keys are recorded and replayed from the cache. Custom executors see the capability as `ctx.target.tapModifiers` and pass `{ modifiers }` to `ctx.actions.tap`, `doubleTap`, and `secondaryTap`.
