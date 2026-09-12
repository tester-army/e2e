---
'@e2edev/agent-device': minor
---

Actions settle faster. After a tap, fill, or back, the engine waits for the UI to hold still before the next observation; that quiet window was agent-device's 500 ms default, which put a fixed second on every tap (1.6 s per tap measured, 2 s on an alert, up to 5 s on a screen push). The window is now 150 ms by default, enough to catch a running animation since every frame changes the tree, and the new `settle` option sets it per engine or disables the wait with `false`. A 13-test React Native suite went from 29 s to 17 s on the two tests measured, with every step still passing.
