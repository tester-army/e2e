---
'e2e': minor
---

`EngineSnapshot` gains an optional `truncated` flag for an engine whose tree
leaves out nodes that are on the surface. The runner merges it with its own
byte-budget cut: the model sees a marker at the end of the listing and is told
nodes past it are on screen but not listed, a truncated screen is never
reported unchanged between observations, and the failure evidence header
marks the listing truncated whichever limit cut it.
