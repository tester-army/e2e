---
"@e2e-dev/eas": patch
"@e2e-dev/limrun": patch
---

EAS Simulators fails with `EAS: unexpected response to <operation>` when Expo's API answers without the fields a session needs, instead of a `TypeError`, and a daemon address answered as `null` reads as not ready yet. Limrun names the installed agent-device `package.json` when it declares no version or no `agent-device` bin, instead of reporting version `undefined` or not finding the CLI.
