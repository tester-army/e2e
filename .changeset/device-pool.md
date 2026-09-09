---
'@e2edev/agent-device': minor
---

`device` accepts a list. The engine declares one worker per device (one for a single or unnamed device), so a `workers` above the pool size no longer over-subscribes it; worker slot `n` drives the `n`th entry under the configured session name suffixed with `-<n>` (`e2e-<target>-<n>` by default). Devices boot in `prepare`, one slot after another and outside `launchTimeout`, each opening the pinned `app` once so its automation runner is up before the first attempt. An empty pool is a configuration error.
