---
'@e2edev/e2e': patch
---

`buildTraceEntry` and `readTraceEntry` are exported for custom
`TraceCacheStore` implementations: a remote store (Redis, an API) serializes
`buildTraceEntry(payload)` on write and validates read documents with
`readTraceEntry` — the same trace-1 framing the default file store uses, so
a remote entry can never be trusted more loosely than a local one.
