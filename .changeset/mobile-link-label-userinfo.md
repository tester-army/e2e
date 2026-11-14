---
'@e2e-dev/mobile': patch
---

The step label for `device.openLink` and `device.openApp` now drops a link's `user:password@` part, as it already drops the query and fragment.
