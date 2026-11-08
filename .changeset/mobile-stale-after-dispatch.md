---
"@e2e-dev/mobile": patch
---

A stale-ref refusal that cannot prove nothing was dispatched is now `ACTION_MAY_HAVE_COMMITTED` instead of retryable `NODE_STALE`, so a tap that already reached the app (a drawer toggle, with the stale report arriving during the post-tap settle) is never sent again and the step fails at once instead of re-resolving until `LOCATOR_NOT_FOUND`. Only refusals with `dispatched: no` stay retryable.
