---
'e2e': patch
---

A bare `locator.longPress()` holds for the engine's own default instead of 500 ms. The SDK filled in 500 ms before the engine saw the action, so the mobile engine's one-second hold never applied, and a React Native `Pressable` with a `delayLongPress` above half a second read the press as a tap. The web engine still holds 500 ms.
