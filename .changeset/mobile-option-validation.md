---
'@e2e-dev/mobile': patch
---

`mobile()` now refuses a `snapshot` value other than `'full'` or `'interactive'` and a `videoTouches` value that is not a boolean, instead of quietly using the default.
