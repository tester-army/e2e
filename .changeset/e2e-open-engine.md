---
"e2e": patch
---

Add `openEngine(engine, options?)` to `e2e/runner`: one attempt on an engine with no config or test, returning the `screen` and engine fixtures a test gets, typed from the engine (`EngineHandle<Fixtures>`, which `defineEngine` infers from its `fixtures`), and `close()`. `app.resolveUrl` in engine fixtures now resolves a full URL on a target without `app.url`; a relative one still throws `APP_URL_REQUIRED`.

An engine opened with no secrets inside a run worker (`attachBrowser` in smol's `prepare`) no longer hides the run's secrets and credentials while it is open.
