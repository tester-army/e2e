---
'@e2edev/mobile': minor
---

The engine declares the `swipeTo` pointer action and performs it as a coordinate swipe from the point to `target`, so `screen.swipe({ from, to })` works on a device. A directional swipe at a bare point is still `UNSUPPORTED_CAPABILITY`; `screen.swipe({ direction })` scrolls the screen root as before.
