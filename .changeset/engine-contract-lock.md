---
"@e2edev/e2e": minor
---

Breaking: the engine contract (`@e2edev/e2e/engine`) is reshaped as the locked, UI-only, cross-platform SPI for 1.0. What breaks and what replaces it:

- `EngineSnapshot.nodes` is `root`, one engine-minted node with an id that stays stable across observations; `url` is `location`, an opaque address (a URL on the web, the foreground screen on a device) the harness treats as a URL only when it parses as one; `viewport` is required.
- `Engine.url()` is gone; read `location` off an observation. `Engine.swipe` is gone; the viewport swipe is `perform(root, { kind: 'swipe' })`.
- `Engine.actions` lists the action kinds `perform` honors and is required with it. The agent's tools and the `screen` methods derive from it, so a surface is never offered a verb it cannot do.
- `Engine.app` is data only. The hooks move to `Engine.session: { open, back, restart, reset }` (were `app.navigate`, `back`, `restart`, `clearState`). `restart` and `reset` open nothing on an addressable surface; the harness reopens the app through `open`.
- `EngineInitInfo.testIdAttribute` and `EngineInitInfo.app.baseUrl` are gone. `SemanticNode.testId` carries the node's test id and the `testId` query resolves against it. The root config key `screen.testIdAttribute` is rejected; set `playwright({ testIdAttribute })` instead.
- `press` keys follow one grammar in Playwright spelling (`Control+a`, `Shift+Tab`, `Enter`, one printable character); `parseKey`, `KEY_NAMES`, `KEY_MODIFIERS`, and `LOCATOR_ACTION_KINDS` are exported for engines. An invalid key fails with `INVALID_ARGUMENT` before it reaches an engine.
- `OperationContext.origin` is required. `EnginePrepareInfo.env` is a plain readonly record, and `EnginePrepareResult.env` is the typed channel from a runner-side `prepare` to each worker's `init`.
- Report: the `download` artifact kind is `file`, `usage.downloads` is `usage.files`, and the target record no longer carries `testIdAttribute`.
- `platform` labels the harness recognizes: `web`, `ios`, `android`, `macos`, `windows`, `linux`, `tvos`, `androidtv`.

`spiVersion` stays `1`.
