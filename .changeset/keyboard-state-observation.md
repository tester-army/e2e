---
"e2e": patch
"@e2e-dev/mobile": patch
"@e2e-dev/web": patch
"@e2e-dev/decision": patch
---

Executor observations carry `keyboardVisible`, the engine's measured on-screen keyboard state, absent when it can't tell. The mobile engine sets it, and the decision executor uses it to offer `dismiss_keyboard`.
