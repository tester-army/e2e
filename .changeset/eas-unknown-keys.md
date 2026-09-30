---
'@e2e-dev/eas': patch
---

`easSimulators()` rejects an option it does not take with `INVALID_CONFIG`, naming the nearest known option when it is a likely typo (`buildID` for `buildId`) and every option otherwise; before, a misspelled option was dropped and EAS started a session without it. Its refusals of `buildId` and `applicationArchiveUrl` passed together, and of a `maxIdleTimeMinutes` not below a `maxDurationMinutes` passed with it, are `INVALID_CONFIG` too instead of `CONFIG_LOAD_FAILED`. `e2e` is now a peer.
