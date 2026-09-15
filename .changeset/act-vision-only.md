---
'e2e': minor
---

The built-in agent's default vocabulary gains the point-addressed fallback verbs next to `screenshot` and `tap_at`: `type_at`, `press_at`, and `select_at`, each taking a point in the latest screenshot for a target the tree does not list. Every point is hit-tested against the tree the runner still holds, so a listed control is acted on by id underneath, recorded with a descriptor and replayed from the trace cache like any other action. The rules tell the model to act by id whenever the screen lists the target and to take a screenshot before naming a point; before any screenshot the point verbs answer with that reminder and spend nothing. Once a secret has been filled in the attempt, all five pixel verbs leave the vocabulary together. `waitFor` skips judgments while the screen is unchanged, comparing the pixels along with the tree when they are sent.

For executors: `ctx.actions.hitTest(point)` resolves a point onto the listed control and node under it without acting.

Engines gain a `keyboard` capability (`keyboard.type`, `keyboard.press`, optional `keyboard.dismiss`): input to whatever holds focus, with no node behind it. The agent's `type` and `press` accept no target on such an engine, `type_at` and `press_at` fall back to tapping the point and typing through the keyboard when the tree lists nothing there, and `dismiss_keyboard` is offered where the engine can hide an on-screen keyboard. That is how a field drawn on a canvas, or one a platform flattens out of its accessibility tree, gets its text. Executors get `ctx.actions.typeText`, `pressKey`, and `dismissKeyboard`; the trace cache records and replays them as free actions.
