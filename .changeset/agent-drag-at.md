---
"e2e": patch
---

Add `drag_at` to the agent's pixel tools, in `agent.act` and `e2e mcp`, and `dragAt(from, to)` to `ExecutorActions`: a drag from one screenshot point to another, for a shape on a canvas or a pin on a map. Like `tap_at`, the bare points go to the engine's `dragTo` pointer kind, where the model aimed; an engine without it drags by id when the points land on two different listed controls, like `drag`. The replay cache records both points and replays each the way it replays a `tap_at` point.
