---
"@e2edev/e2e": patch
---

`app.services[]` entries accept an optional `name`. Errors from a service that fails to start, never becomes ready, or whose teardown fails now read `service "postgres" exited with code 1 instead of 0` rather than naming the service by its position and full command line, which was unreadable behind a shell wrapper. The name defaults to the executable's base name; an explicit name must be a non-empty string of at most 64 characters and unique across the named services, otherwise `INVALID_CONFIG`.
