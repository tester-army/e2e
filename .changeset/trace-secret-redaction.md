---
'@e2edev/e2e': patch
---

A filled credential no longer leaves the runner inside a Playwright trace. The trace recorded the value as typed: in the `fill` action's parameters, in every DOM snapshot of the field, and in the request body that carried it, while the report marked the artifact `redaction: "complete"`. Once a secret was filled in an attempt, the runner now rewrites every text entry of that attempt's trace archives before the trace is registered, hashed, or handed to an artifact store, replacing each credential value (as typed, JSON-quoted, HTML-escaped, and URL-encoded) with `<secret:name>`; screencast frames and other binary entries are carried as they were. A trace from an attempt that filled no secret is labelled `not-required`; one the runner could not rewrite is deleted, and the attempt's `secondaryErrors` carry a `TRACE_WITHHELD` entry. The secret redactor that guards observations, logs, and the cache now covers those encodings as well.
