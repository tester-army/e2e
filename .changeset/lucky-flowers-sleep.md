---
'e2e': patch
---

Write the spec-mandated `A256GCM` algorithm name in session envelopes.

Envelopes carried the Node cipher name `aes-256-gcm`, which the frozen
`session-v1` schema rejects (`SESSION-SCHEMA-001`). The encryption itself is
unchanged — still AES-256-GCM — only the wire literal is corrected. Envelopes
written by an earlier version are not readable by this one; sessions are
per-run, so nothing persists across runs.

Produced envelopes are now Ajv-validated against
`spec/schema/session-v1.schema.json` in the test suite, so this drift cannot
recur silently.
