---
"@e2e-dev/web": patch
---

An observation no longer creates and releases an element handle for every node it lists. The reader keeps its elements in one in-page array per document, and an action makes the handle for its node the first time it reaches for it. Reading a 3000-node page takes about 80 ms instead of about 360 ms, and the engine stops blocking its event loop for around 100 ms releasing the previous observation's handles. References still name the element the walk read.
