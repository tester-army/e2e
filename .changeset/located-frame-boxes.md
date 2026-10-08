---
"@e2e-dev/web": patch
---

A node inside a frame reports its box in the page's viewport, past the frame's border and padding, whether it was located or observed, so `tap({ position })`, a point the agent taps, and `toHaveScreenshot` on it land on the node.
