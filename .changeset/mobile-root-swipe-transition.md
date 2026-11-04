---
"@e2e-dev/mobile": patch
---

Wait out the remaining transition budget before a test scrolls the screen, including after dismissing a native alert. Waits stay within the swipe's action timeout, and cancelled waits send no scroll.
