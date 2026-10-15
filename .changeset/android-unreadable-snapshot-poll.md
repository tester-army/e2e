---
'@e2e-dev/mobile': patch
---

Locators and `expect` now keep waiting while Android reports insufficient foreground app content (an app still loading after a cold start) instead of failing at once. A wait that runs out on an unreadable screen fails with that reason.
