---
"@e2e-dev/decision": patch
---

The decision executor offers `dismiss_keyboard` from the observation's `keyboardVisible` when the engine measured the keyboard, and falls back to the tree's `keyboard` and `key` nodes when it did not. A keyboard the tree leaves out no longer hides the control, and key nodes left behind after the keyboard closed no longer offer it. A dismissal that changes only the measured state, not the tree, counts as a change on screen.
