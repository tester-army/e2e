---
'@e2edev/e2e': minor
---

A `url` on a literal loopback address declared with port 0 (`http://127.0.0.1:0`, `http://[::1]:0`) asks the run for a free TCP port. The runner picks one when the config loads, before anything spawns, and substitutes it in the base URL, the default `allowedOrigins` entry (and an explicit one spelled with the same host and `:0`), the default `readyUrl`, and the report's target record; worker processes receive the same assignment, as does a session opened by `e2e mcp`. Port 0 on any other host is `INVALID_APP_URL`, `localhost` included: a name may resolve to another address than the one the command binds, and a port free on one is not free on the other.

`{port}` in the app command's `args` and `env`, in `readyUrl`, and in each service's `args`, `env`, `readyUrl`, and `teardown` expands to the port the app is served on, allocated or fixed; the command must take the port through it. On a target without a `url` the token is `INVALID_CONFIG` naming the field. Services keep the ports their config gives them. The port is free when chosen and handed to the command a moment later; another process binding it in between fails the start with `APP_UNREACHABLE`, which a rerun resolves.

The default cache and session identity derives from the declared URL with `:0`, so trace cache entries survive the port changing per run. Tests read the resolved URL from the new `app.baseUrl`, `undefined` on a surface whose engine declares no `url`.
