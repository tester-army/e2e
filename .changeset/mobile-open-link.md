---
'@e2edev/mobile': minor
---

`device.openLink(url, { app? })` opens a deep link (`myapp://orders/42`) or a web link on the device, into the pinned app by default, for magic-link sign-in and deep-link routes; the session observes that app afterwards. iOS launches the app for a web link and then opens the URL, Android starts the link on the package. Without an app, Android lets the OS route the link and the session follows the package that took it; iOS needs one (`INVALID_ARGUMENT`), since an open bound to no app leaves nothing to observe. `file:`, `data:`, and `javascript:` links are `POLICY_DENIED`, as on the web. The step is recorded as `device.openLink` with the link cut before its query, so a magic-link token never enters the report.
