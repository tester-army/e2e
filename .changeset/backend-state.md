---
'e2e': minor
---

Backends can carry platform-neutral **state** (RFC0002 step 2', part 1):
`defineBackend({ state: { capture, restore } })` where the snapshot is opaque
JSON the harness never inspects. Session save/restore (`test.setup` +
`session:` option) now works on backend targets through this capability,
exactly as it does for drivers — a browser's storage state, a device's app
state, and a desktop's window state satisfy it identically. Nothing
web-shaped enters the contract. Artifacts land with the playwright backend,
where the real evidence-writing story lives.
