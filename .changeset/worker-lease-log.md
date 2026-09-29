---
'@e2e-dev/web': patch
---

A browser provider's progress lines reach the reporter from a worker too. Kernel's `browser <id>, watch at <live view URL>` line was dropped for every browser in `scope: 'attempt'` and for a replacement after a browser dropped; it now shows, prefixed with the target and worker slot.
