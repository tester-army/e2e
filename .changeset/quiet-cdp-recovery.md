---
"@e2edev/playwright": minor
---

Add opt-in CDP transport recovery through `connect.reconnectEndpoint`. A dedicated persistent browser preserves the original page and context across disconnects, verifies their CDP identities, and invalidates stale references. Every attempt provisions a fresh browser, and dispatched operations are never repeated.
