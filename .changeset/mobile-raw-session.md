---
"@e2e-dev/mobile": patch
---

Custom tools can use `unstable_deviceSession(...engines)` from `@e2e-dev/mobile/tools` to access the running attempt's raw driver session for capabilities e2e does not wrap yet. It shares `DeviceSession` with `device.unstable_raw`. The raw client is typed as `DeviceSessionClient`, exported from `@e2e-dev/mobile`. Both escape hatches can change in any release.
