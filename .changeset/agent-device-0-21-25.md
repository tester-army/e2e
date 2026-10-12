---
"@e2e-dev/mobile": patch
---

agent-device 0.21.25: `settings permission --app` resolves a display name to the installed app's id and refuses an app that isn't installed ([callstack/agent-device#3386](https://github.com/callstack/agent-device/pull/3386)), and on iOS a canceled request keeps its session until the runner finishes the canceled command ([callstack/agent-device#3385](https://github.com/callstack/agent-device/pull/3385)).
