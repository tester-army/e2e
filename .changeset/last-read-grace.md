---
'e2e': patch
---

`locator.waitFor`, `expect` on a locator, and `toHaveScreenshot` give their last read extra time past the timeout, up to their slowest read so far and within the test timeout, so a screen that shows up during a slow last read still passes.
