---
'@e2edev/agent-device': minor
---

Declares the `keyboard` capability: `keyboard.type` types into the focused field through the device's text input, `keyboard.press` sends Enter, Space, or a character to it, and `keyboard.dismiss` hides the soft keyboard. Replacing the focused field's value without a node is refused; fill a listed field by id to replace it.
