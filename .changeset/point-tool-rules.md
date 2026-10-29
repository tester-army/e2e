---
"e2e": patch
---

The built-in agent's instructions now say that `tap_at`, `hover_at`, and `drag_at` act on the bare points when the engine supports it, and fall back to the listed controls by id only when it does not. They previously said every point tool acts on a listed control by its id.
