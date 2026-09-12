---
"@e2edev/playwright": minor
---

Breaking: follows the reshaped engine contract. `playwright({ testIdAttribute })` names the attribute `getByTestId` and observed `testId` values read (default `data-testid`); the root config key `screen.testIdAttribute` no longer exists. `app.restart()` and `app.clearState()` land on a blank page and the runner reopens the app. Observations carry one `root` node (the document, id `root`) and `location` (the page URL). `waitForDownload` registers a `file` artifact. `press` keys outside the shared grammar fail with `UNSUPPORTED_CAPABILITY`.

Fixed: `screen.getByTestId` now honors the configured attribute; it used Playwright's process-wide default before.
