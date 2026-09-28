---
'@e2e-dev/web': minor
---

`web({ viewport: null })` emulates no page size: the page fills the browser window, and observations, screenshots, swipes, and the video recording use the window's size, measured in the page. For a headed run or a hosted browser whose live view shows the whole window, where the fixed 1280 by 720 default renders in one corner of it. `web.setViewport` still fixes a size for the rest of the attempt.
