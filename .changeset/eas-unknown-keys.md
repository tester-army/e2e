---
'@e2e-dev/eas': patch
---

`easSimulators()` rejects an option it does not take with `INVALID_CONFIG`, naming the nearest known option when it is a likely typo (`buildID` for `buildId`) and every option otherwise; before, a misspelled option was dropped and EAS started a session without it. Its refusals of both `buildId` and `applicationArchiveUrl`, and of a `maxIdleTimeMinutes` not below `maxDurationMinutes`, are `INVALID_CONFIG` too instead of `CONFIG_LOAD_FAILED`. `e2e` is now a peer.
