---
'e2e': patch
---

A saved subscription login whose refresh token the vendor rejects now fails naming the command that fixes it, `npx e2e login <provider>`, the way a missing login already did. Before, the run reported `MODEL_PROVIDER_FAILED: ... (401: ...); sign in again` with no provider id to type.
