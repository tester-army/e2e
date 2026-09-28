---
'@e2e-dev/mobile': patch
---

agent-device 0.21.16: `device.enrollBiometrics` and `device.setBiometrics` drive a simulator's Face ID and Touch ID. 0.21.15 refused both as unsupported on the iOS 26 runtime.
