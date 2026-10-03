---
'@e2e-dev/web': patch
---

A screenshot no longer takes the failure that a route or dialog handler left behind. `app.screenshot()` used to fail with it, and the runner's own frames (`screenshot: 'every-step'`, the failure screenshot) could swallow it, letting a failing test pass; now the next step that drives the page, or the attempt's end, fails with it.
