---
"@e2e-dev/mobile": patch
"@e2e-dev/e2b": patch
"@e2e-dev/limrun": patch
"@e2e-dev/testmu": patch
---

Update agent-device to 0.21.37. Without `device`, the iOS pool no longer picks a paired iPhone that is not connected: agent-device now lists a phone whose CoreDevice tunnel is unavailable as not booted. Naming such a phone in `device` fails in `prepare` with a `not_ready` hint, before any test runs, instead of at app launch. 0.21.37 also accepts `postGestureStabilization`, so the read after a test's own swipe or scroll no longer waits up to 3.5 s.
