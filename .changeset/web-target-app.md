---
'@e2e-dev/web': minor
---

Breaking: `web()` only drives the browser. The app it opens is the target's: `web({ url, environment, identity, command, readyUrl })` becomes `targets: [{ engine: web(), app: { url, ... } }]`, and `web({ services })` is gone with them; every old option is an unknown key, `INVALID_CONFIG`. A `web()` target needs `app.url` and refuses the device fields (`bundleId`, `appPath`, `launchArguments`, `permissions`). A target with `app.url` is a `browser` target, so a test can require one with `requires: ['browser']`.
