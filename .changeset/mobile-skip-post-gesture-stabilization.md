---
"@e2e-dev/mobile": patch
---

Send `postGestureStabilization: false` with a test's own swipe and scroll, so an agent-device release that accepts the option stops holding the next read for up to 3.5 s after a gesture the test then checks with `expect`. The first action on a control within 2 s of such a gesture re-reads the control until two reads agree on where it is, so a tap does not land on a list still coasting and get swallowed. The agent's gestures keep the wait.
