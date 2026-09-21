---
'@e2edev/playwright': minor
---

The engine declares the `swipeTo` pointer action and performs it as a pointer drag from the point to `target`, which is what `screen.swipe({ from, to })` sends. Pointer actions at a point now land on the nearest whole CSS pixel: the browser truncates a fractional coordinate, so a tap composed from a fractional box used to land one pixel early.
