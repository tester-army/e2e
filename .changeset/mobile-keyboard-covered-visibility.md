---
"@e2e-dev/mobile": patch
---

A node under the soft keyboard is hidden: `screen.scrollUntilVisible` keeps scrolling to it, `toBeVisible()` fails on it, and `getByRole` skips it. A tap that agent-device refuses because the keyboard or an overlay covers the target now fails `ACTION_FAILED` with the hint that names the cover, not as an engine failure.
