---
"@e2edev/playwright": patch
"@e2edev/agent-device": patch
---

Both engines now require `@e2edev/e2e` 0.5.0 or newer. They import
`@e2edev/e2e/engine`, which 0.5.0 introduced (0.4.x shipped `/backend`), so
the old `>=0.4.0` range allowed an install whose every import failed.
