---
'e2e': minor
'@e2e-dev/decision': patch
---

**Breaking:** a secret fill no longer turns off screenshots for the model. `agent.assert(..., { vision: 'only' })`, `vision: true`, the `screenshot` and point tools, `e2e mcp`, and `e2e explore` findings keep working after a sign-in, in serial groups, and in tests that restore a saved session. Screenshots still mask secure fields, and secret values are still redacted from all text. A generic secret filled into a plain input, or a value the app shows outside a secure field, such as behind a show-password toggle, is in the screenshot and reaches your model provider, so use test credentials. `StepExecutorContext.pixelsTainted` is removed, and a new step's `visionDegraded` is never `PIXEL_TAINTED`.
