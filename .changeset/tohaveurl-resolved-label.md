---
"@e2e-dev/web": patch
---

`expect(browser).toHaveURL` failures print a relative expected URL resolved against the app URL, the same way it is compared, so it reads beside the absolute observed URL.
