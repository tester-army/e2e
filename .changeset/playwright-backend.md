---
'e2e': minor
'@e2edev/playwright': minor
---

Playwright is a backend, and core knows no platform (RFC0002 step 2').

- `@e2edev/playwright` now exports `playwright(options)`: a `defineBackend`
  body with observation, actions, location, state, artifacts, and the
  contributed `web` fixture. Pass it as `backend: playwright()` on a target.
  Browser and viewport are its options. It also exports `test` typed with
  `web`; `expect` and `credentials` still come from `e2e`.
- The driver SPI is gone: `e2e/driver`, `defineDriver`, `driver:` and
  `browser:` target keys, the top-level `browser` key, and the implicit web
  target. `targets` is required and a target is `{ name, platform, backend? }`.
- `Web`, `WebRoute`, `WebResponse`, `RouteFulfillResponse`, `Cookie`,
  `Dialog`, and `WebExpectation` moved out of `e2e` into `@e2edev/playwright`.
  `expect(fixture)` routes to whatever expectation surface a backend attaches
  through the new `BackendFixtureContext.expectable`. Every `web` method call,
  including `url()`, `title()`, and `cookies()`, is now a recorded step.
- The backend contract grew the members a first-party backend needs, all
  platform-neutral: `perform`, `swipe`, `artifacts`, `app`, `url`, `version`,
  observation pixels, and `BackendInitInfo` carries the app base URL, allowed
  origins, `testIdAttribute`, and `headed`.
- `defineTool` accepts `platforms` to scope a tool pack to targets by
  platform, and `StepExecutorContext.target` names the target a step runs on.
- Reports and session envelopes record `backend: { name, version, spiVersion }`
  instead of `driver`, drop `browser`/`browserVersion`/`viewport` from target
  provenance, and step events use kind `backend` (spec `suiteVersion` 0.6.0).
  `DRIVER_FAILURE` is now `BACKEND_FAILURE`.
