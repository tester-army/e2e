---
'@e2e-dev/web': patch
'e2e': patch
---

The limits of a persistent browser context fail early and name their cause. `app.clearState()` with `kernel({ scope: 'attempt' })`, any provider with `scope: 'attempt'`, or `connect.reconnectEndpoint` fails with `UNSUPPORTED_CAPABILITY` naming that mode, instead of `engine web does not implement it`. A run whose tests consume a session on a target whose engine has no state capability fails with `COLLECTION_ERROR` before any test, instead of failing at `session.save()` after the setup test logged in.
