---
"@e2edev/e2e": patch
---

`e2e explore --help` and the `explore` skill topic no longer say the model can
come from `E2E_MODEL`. Nothing reads that variable: the model is the selected
agent's, constructed in `e2e.config.ts`, as for `e2e run`.
