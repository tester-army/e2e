---
"@e2e-dev/mobile": patch
"@e2e-dev/web": patch
"e2e": minor
---

Preserve mobile node ids across observations using semantic app, screen and row context, and pin native refs to the capture that issued them. Reject recycled rows and replacement screens that reuse identifiers instead of transferring old targets.

Add the optional `EngineSnapshot.nodeIdentity: 'stable'` declaration. Stable sources recover stale native frames only through the same node id; a missing id is never re-found by descriptor. Legacy engines retain descriptor recovery. The web and mobile engines declare stable identity and require e2e 0.19.0 or newer.
