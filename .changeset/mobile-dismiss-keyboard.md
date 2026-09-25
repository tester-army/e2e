---
'@e2edev/mobile': patch
---

`device.dismissKeyboard()` works on an iPhone. agent-device presses the keyboard's own dismiss key and refuses when there is none, so the engine now does what a user does and what Maestro's `hideKeyboard` does: a short drag at the centre of the screen, horizontal first and vertical second, each followed by a fresh look at whether the keyboard is still up, with the simulator's "Speed up your typing" tip dismissed through its Continue button first. A keyboard that outlives both drags still fails with `UNSUPPORTED_CAPABILITY`, naming the app's own Done control and Enter as the alternatives.
