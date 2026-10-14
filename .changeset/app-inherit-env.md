---
"e2e": minor
---

`app.command.inheritEnv` passes host variables to the app by name or trailing-`*` prefix (`['DATABASE_URL', 'STRIPE_*']`), copying each one only when it is set, so a host can hand the app per-run values without listing them in the config or spreading `process.env`. `command.env` wins over an inherited value, and inherited values are redacted from a quoted startup failure like `command.env`. A bare `*` and a `*` anywhere but the end are `INVALID_CONFIG`.
