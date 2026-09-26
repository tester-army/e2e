---
'e2e': patch
---

A `download` artifact no longer claims `redaction: 'complete'` for bytes the runner never looked at. A file the app served is recorded `incomplete` unless a secret was filled on the session and the download is text (`.txt`, `.csv`, `.json`, `.html`), in which case the runner rewrites it through the secret ledger before hashing or storing it and labels it `complete`. `StoredArtifact` now carries that `redaction`, so an `artifacts.store` that exports only what the runner vouches for can tell a rewritten export from one that may still hold a filled value.

The secret redactor also matches a value whose double quotes are doubled, the way CSV writes a quoted field, so a rewritten CSV export no longer keeps such a value.
