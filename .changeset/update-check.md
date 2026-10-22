---
"e2e": patch
---

Print a notice after a command when a newer `e2e` is on npm, with the install command for the project's package manager. The registry is checked once a day. Nothing prints in CI or when piped. Set `E2E_UPDATE_CHECK_DISABLED=1` or `NO_UPDATE_NOTIFIER=1` to turn it off. `E2E_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` turn it off too.
