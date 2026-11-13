---
"e2e": patch
---

Reject a config timeout above 2147483647 ms with `INVALID_CONFIG` instead of letting every test time out at once.
This covers `timeout`, `launchTimeout`, `actionTimeout`, `assertionTimeout`, `cleanupTimeout`, `app.command.startupTimeout` and `shutdownTimeout`, and `agents.<name>.judgmentTimeout`.
A test's or group's own `timeout` above that limit now fails collection too.
