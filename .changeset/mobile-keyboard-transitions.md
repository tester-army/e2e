---
"@e2e-dev/mobile": patch
---

Reobserve controls after the transition budget following text entry, even when the first snapshot has unchanged bounds, so a delayed keyboard animation does not send the next tap to the old position. Retry moving-target refusals only when agent-device confirms no input was dispatched.
