---
'e2e': patch
'@e2edev/web': patch
---

Three artifacts carried secrets under a clean label. A download was recorded as `redaction: 'complete'` without anyone reading it: an exported CSV holding a configured API key reached the report and the artifact store as fully masked. It is now scanned against the attempt's secret ledger; one that holds a value is deleted, recorded without a path, and explained with `ARTIFACT_WITHHELD` in the attempt's `secondaryErrors`. A trace was rewritten only after a secret fill, so a settings page that rendered a configured static value, or the `headers` a protected preview needs, reached the trace in clear under `not-required`. Every trace from a session whose ledger holds a value is now rewritten and labelled `complete`; `not-required` means the ledger was empty. The browser engine registers the `headers` values and the `basicAuth` password at attempt start, and the cookie and local-storage values of a session it captures or restores (16 characters or more), through the new `EngineAttemptContext.registerSecret`, so they read `<secret:header.<name>>` and `<secret:cookie.<name>>` in the trace instead of their value.
