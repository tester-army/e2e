---
'@e2edev/web': patch
---

A locator read that lands on an element the app has just replaced re-resolves instead of reading the detached node. A field re-rendered as an identical clone on every animation frame reported `hidden` whenever a read caught the old element, so `toBeHidden()` could pass and `isHidden()` answer `true` while the field was on screen, by test id, label, or display value alike. The read now reports the match stale and the runner looks it up again within the same deadline; a field that is really removed still reads as hidden. Only a replaced element that could have been a match re-resolves, so a stable field found by exact label or display value resolves at once while unrelated fields re-render every frame.
