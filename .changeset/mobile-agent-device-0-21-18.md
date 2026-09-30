---
'@e2e-dev/mobile': patch
---

agent-device 0.21.18: `device.setClipboard` writes the iOS simulator clipboard under Xcode 27, where it did nothing before, a live daemon is probed again before being replaced as unreachable, and Android retries once after a device-offline refusal. The docs no longer mark `getByPlaceholder` and `toBeFocused` as Android only; both have worked on iOS since agent-device 0.21.16.
