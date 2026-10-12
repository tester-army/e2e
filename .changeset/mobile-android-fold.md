---
"@e2e-dev/mobile": minor
---

`device.fold` works on foldable Android emulators. agent-device 0.21.25 sets the emulator console posture and waits for the device state Android commits, so the engine no longer refuses Android before the command; a fold to the cover display also clears the lock screen the emulator raises. Before, `device.fold` on an Android target failed with `UNSUPPORTED_CAPABILITY`.
