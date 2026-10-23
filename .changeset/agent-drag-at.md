---
"e2e": patch
---

Add `drag_at` to the agent's pixel tools and `dragAt(from, to)` to `ExecutorActions`: a drag from one screenshot point to another, for a shape on a canvas or a pin on a map. When the points land on two different listed controls the drag runs by id, like `drag`; otherwise the bare points go to the engine's `dragTo` pointer kind. The replay cache records both points and replays each the way it replays a `tap_at` point.
