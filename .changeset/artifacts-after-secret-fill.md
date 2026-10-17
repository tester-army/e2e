---
"e2e": patch
---

Keep screenshots after a secret fill. `app.screenshot()`, `toHaveScreenshot()`, and assertion and failure screenshots no longer stop once a test fills a secret. They mask secure fields only, and `toHaveScreenshot()` still fails when the engine can't prove they are masked. The model still gets no pixels after a fill.
