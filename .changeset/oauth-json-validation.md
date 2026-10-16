---
"e2e": patch
---

Subscription sign-in, token refresh, and `e2e models` fail with `FLOW_FAILED` naming the vendor when a successful response's body is not JSON or not the expected shape, instead of a `TypeError` or `SyntaxError`. `e2e models` skips a model entry it cannot read, and `opencodeConsole()` treats a malformed workspace config like one it could not fetch.
