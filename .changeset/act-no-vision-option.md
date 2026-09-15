---
'e2e': minor
---

Breaking: `agent.act` takes no `vision` option and `agents.<name>.vision` is gone. The act model always works from the semantic tree and asks for pixels itself: it calls `screenshot` when the tree lacks what it needs, and from then on every action result carries a fresh screenshot and the point verbs (`tap_at`, `type_at`, `press_at`, `select_at`) act at points in it. There is no pixels-only mode and no screenshot-on-every-turn mode; the model decides, not the config. `vision` on `act` fails with `UNSUPPORTED_CAPABILITY`, and `agents.<name>.vision` is an unknown config key. `vision` stays on the judgments (`assert`, `waitFor`, `extract`) with `false` as the only default.

For executors: `ctx.vision` is removed from `StepExecutorContext`; `observe({ pixels: true })` is the one way to ask for pixels, and a custom executor's `agent.assert` rejects `vision` like it rejects `screenshot`.
