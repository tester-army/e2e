---
"e2e": patch
---

Engines receive the app's origin as `EngineAppInfo.origin` in `prepare` and `init`, on the run's port when `app.url` asks for a free one (and left out until the run assigns it), so an engine can scope a credential it injects to the exact origin.
