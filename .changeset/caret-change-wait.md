---
"e2e": patch
---

An agent step no longer waits two seconds after a caret key that changes nothing. ArrowLeft, ArrowRight, Home, End, or select-all pressed in a text field that already holds the focus waits one second for the screen to react, not two. A tap, ArrowUp and ArrowDown, the first key that gives a field the focus, and a key batched after another action still wait the full window. A replay of a recorded rich-text editing flow takes about 14.6 s instead of 20.5 s.
