---
'@e2e-dev/web': patch
---

Keep secure-field masks working after WebKit JavaScript-URL frames rewrite their documents. Query light and open roots with init-captured native DOM methods in the main world, retain every frame's closed-root mask, and refuse relevant DOM overrides or CDP documents without the current hooks.
