---
'@e2edev/agent-device': patch
---

An agent-device failure keeps its hint in the engine error message. `dismissKeyboard` on an iPhone keyboard is refused upstream because the keyboard shows no dismiss key and agent-device taps nothing outside it; the model used to see only the refusal and retried it, and now reads the recovery path (the app's own Done control, or pressing return) in the same message.
