---
'e2e': minor
---

Coordinate input for the deterministic API. `screen.tapAt({ x, y })` taps a viewport point with no node behind it, `screen.swipe({ from, to })` swipes along a path between two points (a touch swipe on a device, a pointer drag on a document platform), and `tap({ position })` on a locator (also `click`) taps at an offset of the node's box, scrolling it into view first when the engine can. Points are CSS pixels, the space `boundingBox()` reports in; a negative or non-finite coordinate is `INVALID_ARGUMENT`, and an engine without the matching pointer action is `UNSUPPORTED_CAPABILITY` before anything is resolved. Engine contract: a new `swipeTo` pointer action kind (`{ kind: 'swipeTo', target }`) carries the path swipe, and `TargetSession` exposes `pointerActions`. `Point`, `TapOptions`, and `SwipePathOptions` are exported.
