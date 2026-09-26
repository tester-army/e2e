---
'@e2edev/mobile': patch
---

Android's status bar stays out of the tree again. agent-device 0.21.15 reports each status icon (the clock, the signal and Wi-Fi, the battery, a notification icon) as a top-level node of its own instead of one edge-to-edge bar, so the clock and the signal text were back in every observation, and an end anchor on them handed replays to the model once the signal changed. A narrow systemui node lying wholly inside the screen's edge band is now left out too; a wide popup there, like a heads-up notification, stays.
