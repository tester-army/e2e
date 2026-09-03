---
'@e2edev/e2e': minor
---

The backend contract (RFC0002): `@e2edev/e2e/backend` ships `defineBackend`, and
targets accept `{ name, platform, backend }` with no driver — no browser is
resolved or launched, and `app.url` becomes optional when every target is a
backend target. A backend declares its capabilities: `observe()`
unlocks the judgment tier and agent observation, and `actions` (the closed
verb set) unlocks harness-routed grammar actions. Undeclared capabilities fail loud with
`UNSUPPORTED_CAPABILITY`, never silently. Backends get `init`/`dispose`
lifecycle hooks bounded by the launch and cleanup timeouts.

`agent` config now accepts an executor alongside the options:
`agent: { executor, model, maxModelCalls, context }` — a custom brain no
longer forfeits the model, budgets, or project context.
