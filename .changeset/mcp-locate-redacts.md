---
'e2e': patch
---

`e2e mcp`'s `locate` showed a filled secret in plaintext: it read the matching nodes straight from the engine and rendered `value` raw, hiding it only for a secure field, so after `type_secret` of a generic secret into a plain textbox (or a password fill followed by a show-password toggle) `call locate {label}` handed the value to the coding agent. Located nodes now go through the projection `observe` gives an executor, so a filled value reads `<secret:name>` and a secure node has none, and every text a `call` returns, results and errors alike, passes the attempt's secret ledger.

The redactor never rewrites a marker it wrote. Text is cut at the `<secret:name>` markers of the names it knows and each marker it writes is final, so text that passes it twice reads as text that passed once, and a value that occurs inside a marker (`api` inside `<secret:apiKey>`, the word `secret`) no longer turns it into `<secret:<secret:apiKey>Key>`.
