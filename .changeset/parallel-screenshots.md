---
"@e2e-dev/web": patch
---

Two `toHaveScreenshot` calls (or other screen reads) running at once on one page no longer fail with `LOCATOR_NOT_FOUND: node became stale`. The engine now takes concurrent observations in turn.
