---
'e2e': patch
---

A restored session keeps the secret protection of the setup test that saved it. Before, a secret resolved from a provider function and filled during setup was known only to that setup's session: a consumer test that restored the session and met the stored value again (an app echoing a token from local storage, say) printed it raw in the assertion failure, the report, the log, and the failure screen, while a static config secret in the same flow stayed masked. The saved session now carries the values the saving session learned inside its encrypted payload, and its taint, so the consumer redacts them and withholds pixels the same way. Nothing is written unencrypted; the envelope names the secrets, and the session schema gains an optional `secrecy` field.
