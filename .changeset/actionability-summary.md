---
'@e2e-dev/web': patch
---

An action that times out waiting to become actionable reports Playwright's headline and the last blocker its call log names, such as `<div data-popover>… intercepts pointer events`, instead of the whole log repeated once per retry. The agent read that log as model input, several thousand characters per blocked tap.
