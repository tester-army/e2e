---
'e2e': patch
---

`waitFor`, `expect` on a locator, and `toHaveScreenshot` give their last read extra time past the timeout, as long as their slowest read so far, so a screen that shows up during a slow last read still passes.
