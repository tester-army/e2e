---
'e2e': minor
---

`app.open()` on a device target launches the pinned app fresh, the way Maestro's `launchApp` does; it takes no path there (a link goes through `device.openLink`). It was `APP_URL_REQUIRED` on every device target before.
