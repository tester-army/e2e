---
"@e2e-dev/mobile": patch
---

Every settings request now names the device the worker drives, like the boot, open, and install requests already did. `app.clearState()`, `device.setPermission()`, `device.setLocation()`, network, appearance, and biometric changes were resolved against every booted device, so a second booted simulator or emulator failed them with "2 devices match this request equally", and one engine failure then failed every later test of the run at its clear-state step.
