---
"@e2edev/e2e": minor
---

Add `app.services`: ordered dependency processes (a database container, a cache, an auth emulator, a migration step) that start sequentially before `app.command`, each ready before the next via a `readyUrl` probe or `waitForExit: true`, and are torn down in reverse on every exit path, followed by each service's optional `teardown` command. A service with neither readiness contract is `INVALID_CONFIG`; a readiness failure is `APP_UNREACHABLE` naming the service; a failing teardown is a `cleanup`-phase run error. Service and teardown `env` values enter the config digest as names only, like `app.command.env`. `app.readyUrl` is now validated as an absolute http(s) URL at config time, the same rule a service `readyUrl` follows, and `app.command` startup errors name it `app.command` rather than `app command`.
