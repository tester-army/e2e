---
'@e2e-dev/mobile': patch
---

A tap agent-device refuses because the target has no point to touch (covered, off screen, or covered by its own interactive children) now fails as `NOT_ACTIONABLE` with agent-device's hint, instead of an engine failure. A cached replay retries it once after the screen holds still.
