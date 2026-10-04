---
'e2e': patch
---

A secret value a test passes as a plain string (spelled into an `app.open` URL, typed with `fill`) no longer stays in the Playwright trace. Traces and text downloads are now rewritten whenever the session knows a secret value (every static one, and a provider's once resolved), not only after a secret fill or an engine-held secret, so they are labeled `redaction: "complete"` instead of `not-required` or `incomplete`. Screencast frames are still dropped only after a secret fill. Like any secret trace, a rewritten one masks unrelated text that shares 8 characters with a value.
