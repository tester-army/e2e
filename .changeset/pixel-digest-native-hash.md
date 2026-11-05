---
"e2e": patch
---

The agent compares screenshots with a native SHA-256 instead of a byte-by-byte loop in script, so a settle poll or screen update that carries pixels no longer spends about 8 ms of the event loop per megabyte of image.
