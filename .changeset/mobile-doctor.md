---
"@e2e-dev/mobile": patch
---

`e2e doctor` checks a mobile target: agent-device, the platform toolchain, each configured device, an installed `bundleId`, and the `appPath` build. Requires e2e 0.22.1 or newer.

`mobile({ device })` now rejects a blank device name at config load instead of failing the run's boot.
