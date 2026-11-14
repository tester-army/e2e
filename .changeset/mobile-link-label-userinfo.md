---
'@e2e-dev/mobile': patch
---
The step label for `device.openLink` drops a link's userinfo, query, and fragment, and shows `<link>` for a string that does not parse as a URL. `device.openApp` labels an app id as it is, or `<link>` when it is shaped like a link.
