---
'@e2edev/e2e': minor
---

Secrets are no longer passwords only. A new `secrets` config block declares any value the model must never see (an API key, a token, anything from the environment), as a string or a provider function, overridable per run with `E2E_SECRET_<NAME>`. `secrets.get(name)` from `@e2edev/e2e` returns the same opaque `Secret` handle a credential's password is, accepted by `locator.fill`, `agent.act` params, and the `type_secret` tool; the runner fills it, masks it in every observation, and redacts it from logs, traces, and the report. A password still fills only a password field; a generic secret fills any editable input. An unconfigured name fails with the new `SECRET_UNAVAILABLE` code. `Secret.purpose` narrows to `'password' | 'generic-secret'`; `'one-time-code'` was never produced.
