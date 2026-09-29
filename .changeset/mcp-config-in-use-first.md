---
'e2e': patch
---

`e2e mcp`: `open_session` on a config other than the one the open sessions use fails with `CONFIG_IN_USE` before the config evaluates. A config that hands an engine option `secrets.get()` of a secret only it declares no longer fails with a misleading `secret "..." is not configured` resolved against the open session's config.
