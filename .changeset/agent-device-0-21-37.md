---
"@e2e-dev/mobile": patch
"@e2e-dev/e2b": patch
"@e2e-dev/limrun": patch
"@e2e-dev/testmu": patch
---

Update agent-device to 0.21.37. Without `device`, the iOS pool no longer picks a paired iPhone that is not connected: agent-device now lists a phone whose CoreDevice tunnel is unavailable as not booted. A `device` that names such a phone fails in `prepare` with "iOS device is not ready for automation", before any test runs, instead of at app launch. A test's own swipe and scroll now skip agent-device's post-gesture wait, which 0.21.36 ignored. On iOS, `device.back()` swipes from the left edge and fails when the screen does not change; tap the close control on a modal.
