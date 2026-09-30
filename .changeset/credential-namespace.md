---
'e2e': minor
---

Breaking: credentials and secrets are separate namespaces. `secrets.get(name)` returns `config.secrets` entries only and no longer a credential's password, which is `credentials.user(name).password`; the error for a credential's name says so. A credential's password handle is named `<name>.password` (`admin.password`), which is what the agent, `<secret:...>` redaction markers, `e2e mcp`, and the replay cache see, so a credential and a secret may now share a name. A `secrets.get()` in an engine option must name a `config.secrets` entry. Replay cache entries recorded with a credential's password miss once and re-record.
