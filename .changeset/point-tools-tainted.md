---
'e2e': patch
---

Once a secret has been filled in an attempt, `tap_at`, `hover_at`, `type_at`, `press_at`, and `select_at` answer with the `PIXEL_TAINTED` line instead of acting: the screenshot the model holds predates the fill and may no longer match the screen. Before, they kept aiming at that stale screenshot, while the MCP catalog and the docs said they would refuse. The bundled agent skill (`e2e guide`) is rewritten against the current runner: wrong claims fixed (reads fail at once on zero matches, negated matchers hold for one second, `clearState` has no serial-group limit, `onDialog` is async, `defineConfig` is `CONFIG_LOAD_FAILED`, blocked `act` codes, per-call budgets above the limit are `INVALID_ARGUMENT`), missing options and error codes added, migration notes and engine internals dropped, repeated facts reduced to one home each.
