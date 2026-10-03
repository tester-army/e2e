---
'@e2e-dev/web': minor
---

Init scripts, as Playwright's `addInitScript`: `web({ initScripts })` runs scripts in every document of every attempt before the page's own, in every tab and frame, and `browser.addInitScript(script, arg?)` adds one for the rest of an attempt. A script is JavaScript source, a `{ path }` relative to the project root, or a function serialized into the page with an optional JSON argument. Both survive `app.clearState()`, a session restore, and a CDP reconnect. A configured file that cannot be read is `INVALID_CONFIG`.
