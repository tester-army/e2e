---
"@e2e-dev/web": patch
---

Hide the text caret in observation screenshots with a constructed stylesheet adopted into every frame and shadow root, including the closed roots the engine tracks, instead of writing an inline `caret-color` on every editable element. A server-rendered app hydrating while a capture runs no longer reports a React attribute mismatch on its inputs and textareas, and a page whose `style-src` policy blocks style elements still gets its caret hidden.
