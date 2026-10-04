---
"e2e": patch
---

Replaying a repeated scroll on a list that filled the screen, when the list can no longer be found, waits for it once and then scrolls the screen for every remaining repeat. It used to wait out the full relocation backoff (about 14 seconds) before each repeat, so a recorded 4x scroll took about a minute to replay.
