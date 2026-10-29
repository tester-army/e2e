---
'@e2e-dev/mobile': patch
---

The `open_app` agent tool returns to the target's app when called without an app, so the agent can recover after a system sheet or another app takes the foreground. Device errors no longer end with agent-device's CLI advice, such as "Run apps to discover...".
