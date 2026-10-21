---
"@e2e-dev/testmu": patch
---

`testmuBrowsers()` from `@e2e-dev/testmu/web` runs web targets in TestMu AI (formerly LambdaTest) hosted Chrome or Edge, one session per worker slot: `web({ browser: testmuBrowsers() })`. `@e2e-dev/mobile` and `@e2e-dev/web` are optional peers now, so a project installs only the engine it uses.
