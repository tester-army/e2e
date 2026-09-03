---
'@e2edev/e2e': minor
---

Fill-time secret providers. A credential's `password` may now be a
`SecretProvider` function instead of a string: it is called on every
authorized fill and resolves the plaintext at fill time — a vault lookup, a
freshly computed TOTP. The resolved value goes straight to the trusted
driver, joins runner-side redaction the moment it exists, and is never
logged, cached, or sent to a model. An `E2E_USER_*` environment override wins
over a provider; like executors and custom stores, a provider never crosses a
process boundary. An empty static password — including an empty `E2E_USER_*`
override — is now a configuration error at load, not a fill-time failure.
