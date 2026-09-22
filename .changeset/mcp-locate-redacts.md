---
'e2e': patch
---

`e2e mcp`'s `locate` showed a filled secret in plaintext: it read the matching nodes straight from the engine and rendered `value` raw, hiding it only for a secure field, so after `type_secret` of a generic secret into a plain textbox (or a password fill followed by a show-password toggle) `call locate {label}` handed the value to the coding agent. Located nodes now go through the projection `observe` gives an executor, so a filled value reads `<secret:name>` and a secure node has none, and every text a `call` returns, results and errors alike, passes the attempt's secret ledger.
