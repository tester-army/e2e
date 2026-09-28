---
'@e2e-dev/mobile': patch
---

A worker that replaces one retired after a failing test no longer takes the warm-up's word that its session is on the app. The retired worker closed that session, so the next `device.setPermission` skipped its open and went out on a session bound to no device: with an iOS simulator and an Android emulator booted on one host, agent-device answered `AMBIGUOUS_MATCH`. `init` now keeps the warm-up's app only while agent-device still lists the session, and otherwise the first permission change opens the app again.
