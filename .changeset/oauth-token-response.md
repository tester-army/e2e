---
"e2e": patch
---

Subscription sign-in's code exchange and token refresh fail with `FLOW_FAILED` when the token endpoint answers `null`, instead of a `TypeError`. A `refresh_token` or `id_token` that is not a string is ignored.
