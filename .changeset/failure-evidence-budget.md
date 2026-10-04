---
'e2e': patch
---

A failed attempt on an app that stops answering no longer waits 5 s for failure evidence at every capture point, or forever when the engine ignores cancellation. The runner captures the screen and screenshot once per attempt, stops waiting after 5 s, and keeps the original error.
