---
"@e2e-dev/mobile": patch
---

Re-resolve a locator when its target changes during the transition wait, instead of tapping a stale native reference that may now identify another control.
