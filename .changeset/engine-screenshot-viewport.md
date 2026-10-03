---
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
---

A screenshot now reports the viewport it was measured against beside its path (`{ path, viewport }`): the page's CSS-pixel viewport on a browser, the screen in points on a device. The runner records it on the step, so a step's element box can be placed on an image taken at a higher pixel density.
