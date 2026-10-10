---
"e2e": minor
"@e2e-dev/mobile": minor
"@e2e-dev/web": patch
---

`EngineSnapshot` and `ExecutorObservation` carry an optional `keyboardVisible`: whether an on-screen keyboard is showing, as the engine measured it apart from the tree, and absent when it did not measure it. The mobile engine sets it from the keyboard band agent-device's iOS runner measures with each capture. The web engine does not set it.
