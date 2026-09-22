---
'e2e': patch
---

A saved subscription login the vendor rejects now fails naming the command that fixes it, `npx e2e login <provider>`, the way a missing login already did: a refresh token that is rejected, and a 401 on a token with nothing to refresh it (Copilot's GitHub token), both end as `LOGIN_REQUIRED` with the hint. Before, the run reported `MODEL_PROVIDER_FAILED: ... (401: ...); sign in again` with no provider id to type, and a revoked Copilot token surfaced as a bare HTTP 401.
