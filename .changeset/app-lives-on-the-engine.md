---
'@e2edev/e2e': minor
'@e2edev/playwright': minor
'@e2edev/agent-device': minor
---

The app under test is declared by the engine that drives it, not by the
config. The top-level `app` key (`url`, `command`, `readyUrl`, `services`,
`allowedOrigins`, `environment`, `identity`) is gone, and so is the runner's
`APP_URL` fallback: the browser engine takes the same fields as options,
`playwright({ url, command, services, ... })`, and the device engine derives
the identity from the app it pins (`agentDevice({ platform, app })`, or an
explicit `identity`). Two web targets on one app each name it; services and
commands declared identically by several targets start once.

For engine authors, the `app` manifest of `defineEngine` carries the
declaration (`EngineAppDeclaration`) beside its hooks, and the runner
resolves it per target: navigation policy, cache and session identity, the
report's target record (`baseOrigin` is now absent for a surface without a
URL), and the app process all read from there. A device target can finally
declare a stable identity without inventing a URL. `@e2edev/e2e/engine` also
exports `obj`, the one-call replacement for the conditional-spread
idiom when a declaration is built from optional inputs.

Migrate by moving the `app` block into the engine factory:

```ts
// before
app: { url: 'http://localhost:3000' },
targets: [{ name: 'web', platform: 'web', engine: playwright() }],
// after
targets: [{ name: 'web', platform: 'web', engine: playwright({ url: 'http://localhost:3000' }) }],
```
