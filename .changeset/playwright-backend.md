---
'e2e': minor
'@e2edev/playwright': minor
---

**Breaking.** Playwright is a backend, and core knows no platform (RFC0002
step 2'). The bumps stay `minor` under the 0.x policy, but the shapes below
are removed or changed and a project upgrading must migrate its config and any
backend it wrote.

Removed:

- `e2e/driver`, `defineDriver`, and every driver-SPI type; the `driver:` and
  `browser:` target keys; the top-level `browser` config key; the implicit
  zero-config web target. `targets` is required and a target is
  `{ name, platform, backend? }`.
- The `actions` verb object on a backend (`actions: { tap, type, press,
  select, scroll, navigate, back }`). Every node action is now
  `perform(ref, action, context)` taking one `LocatorAction`; viewport scroll
  is `swipe(direction, momentum, context)`; `navigate` and `back` live under
  `app: { navigate?, back?, restart?, clearState? }`. The `actions` capability
  means `perform` is declared, and the agent offers the model only the verbs
  the backend declares.
- `artifacts: ['video']` is no longer accepted in config, and `video` is gone
  from the report's `artifactCapabilities` (a fixture may still attach a
  `video` artifact).
- `DRIVER_FAILURE` is now `BACKEND_FAILURE`.

Changed:

- `Backend.version` is required (a non-empty string): it is provenance and
  keys the trace cache.
- `endAttempt(context)` and `dispose(context)` receive a
  `BackendCleanupContext` (`{ signal, timeoutMs }`) whose `signal` aborts when
  the cleanup budget is spent. `dispose` runs whether or not `init` ran, and
  `init` may run again after `dispose` on the same handle.
- `defineBackend` validates the nested `state`, `artifacts`, and `app`
  manifests (closed keys, function members), binds every method so a class
  instance is a valid body, and rejects unknown nested keys with
  `INVALID_CONFIG`.
- `BackendInitInfo.app.baseUrl` and `BackendFixtureContext.app.baseUrl` are
  optional; absent when no app URL is configured.
- `Web`, `WebRoute`, `WebResponse`, `RouteFulfillResponse`, `Cookie`,
  `Dialog`, and `WebExpectation` moved out of `e2e` into `@e2edev/playwright`.
  `expect(fixture)` routes to whatever expectation surface a backend attaches
  through `BackendFixtureContext.expectable`. Every `web` method call,
  including `url()`, `title()`, and `cookies()`, is now a recorded step.
- Reports and session envelopes record `backend: { name, version, spiVersion }`
  instead of `driver`, drop `browser`/`browserVersion`/`viewport` from target
  provenance, and step events use kind `backend` (spec `suiteVersion` 0.6.0).

Added:

- `@e2edev/playwright` exports `playwright(options)`: a `defineBackend` handle
  with observation, actions, location, state, artifacts, and the contributed
  `web` fixture. `browser` and `viewport` are its options. It also exports
  `test` typed with `web`; `expect` and `credentials` still come from `e2e`.
- `e2e/backend` exports `BACKEND_ERROR_CODES` and
  `RETRYABLE_BACKEND_ERROR_CODES` (`NODE_STALE`, `FRAME_NOT_FOUND`).
- `e2e/backend` exports the semantics the spec requires every backend to
  reproduce exactly: `TestError`, `ConfigurationError`, `InfrastructureError`,
  `matchesText`, `toTextPattern`, `describePattern`, `urlMatches`,
  `pollCondition`, `Deadline`, and `validateJsonValue`. The `e2e/internal`
  subpath is removed; a backend package depends on `e2e/backend` only.
- `defineTool` accepts `platforms` to scope a tool pack to targets by
  platform, and `StepExecutorContext.target` names the target a step runs on.

Migration:

```ts
// before
export default defineConfig({
  browser: 'chromium',
  targets: [{ name: 'web', platform: 'web', driver: 'playwright' }],
});

// after
import { playwright } from '@e2edev/playwright';

export default defineConfig({
  targets: [{ name: 'web', platform: 'web', backend: playwright({ browser: 'chromium' }) }],
});
```

A backend written against the earlier `e2e/backend` draft moves its `actions`
verbs onto `perform` (switch on `action.kind`), its viewport `scroll` onto
`swipe`, its `navigate`/`back` under `app`, declares `version`, and accepts
the cleanup context on `endAttempt`/`dispose`.
