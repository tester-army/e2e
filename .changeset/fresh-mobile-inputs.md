---
'@e2e-dev/mobile': patch
---

Revalidate mobile fill and clear targets with a fresh accessibility snapshot before mutation, including cached replay. Changed geometry, identity, or security facts return NODE_STALE so the harness re-observes and reruns secret authorization instead of dispatching an old binding. Initially non-input targets fail immediately with UNSUPPORTED_CAPABILITY instead of entering stale retries. Coordinate-only backends can still race movement after this check.
