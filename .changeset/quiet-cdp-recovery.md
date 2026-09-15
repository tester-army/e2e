---
"@e2edev/playwright": minor
---

Add opt-in CDP transport recovery through `connect.reconnectEndpoint`. A dedicated persistent browser preserves the original page and context across disconnects, verifies their CDP identities, and invalidates stale references. Every attempt provisions a fresh browser, and dispatched operations are never repeated.

Recovery and dispatch share one operation budget, with timeout exhaustion distinguished from caller cancellation. Reads from an earlier connection cannot publish stale observations, and each attempt owns its connection and recordings through cleanup.

Observation-backed pointer and keyboard input requires fresh evidence after reconnect. Cancelled typing cannot continue its remaining keystrokes after a delayed focus read or key delivery.

CDP attachment installs secure-field masks before exposing the context. Recovery refuses documents that lost closed shadow DOM tracking while disconnected, preventing unmasked pixels from those documents.
