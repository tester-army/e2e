---
'@e2edev/playwright': minor
---

`surfaceOf(handle)` exposes the live `Page` and `BrowserContext` behind a
`playwright()` handle to agent-side code, the way `@e2edev/agent-device`
exposes its device surface. A step executor that replaces the toolset
wholesale can now drive the page e2e itself opened, instead of attaching a
second browser it cannot reach. Both accessors read the current attempt and
throw `INVALID_STATE` before it exists; the harness remains the notary for
what it witnesses, and a caller here acts out of band.
