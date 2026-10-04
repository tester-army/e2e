---
'@e2e-dev/web': patch
'e2e': patch
---

A page whose script never yields no longer holds a web test until its test timeout: a tap, a locate, or a navigation on it now fails with `ACTION_FAILED` at its action or navigation timeout, also while a trace records. A failed attempt whose screen could not be read is looked at once, not twice.
