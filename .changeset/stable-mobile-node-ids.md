---
"@e2e-dev/mobile": patch
---

Preserve node ids across mobile observations for uniquely matched controls so keypad presses and value changes no longer replace the entire screen listing. Refresh retained ids with the latest device refs and reset identities on app relaunch or foreground app changes.
