---
"@e2e-dev/web": patch
---

Screenshots no longer change the inline style of editable elements to hide the text caret, so a server-rendered app hydrating while a capture runs no longer reports a React attribute mismatch on its inputs and textareas. A capture runs with the caret hidden in the frames it can reach, and the stylesheet is taken back from every frame afterwards.
