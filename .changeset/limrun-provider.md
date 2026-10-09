---
"@e2e-dev/mobile": patch
"@e2e-dev/limrun": minor
---

Add the Limrun device provider with one hosted instance per worker, app
installation, recording through agent-device, and cleanup on run exit.
Renew retained driver leases while other targets run. Keep provider-owned
local daemons isolated from ambient remote-daemon environment settings.
