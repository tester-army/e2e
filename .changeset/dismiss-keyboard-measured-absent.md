---
"@e2e-dev/mobile": patch
---

`device.dismissKeyboard()` and the agent's `dismiss_keyboard` capture the screen first and send nothing when it measured no keyboard on screen — an explicit `absent` fact, or a measured band lying entirely outside the viewport — instead of dismissing a keyboard that is not there. Keyboard states the producer cannot measure keep the native dismissal.
