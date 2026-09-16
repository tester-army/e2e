---
'@e2edev/agent-device': patch
---

A role query with `level` matches nothing on a device: the accessibility tree reports no heading level, and failing closed keeps a level assertion honest instead of letting any heading satisfy it.
