---
"@e2edev/e2e": patch
---

`ArtifactRecord.redaction` on `@e2edev/e2e/run` mirrors the report-1 schema:
`'complete' | 'not-required' | 'incomplete'`. The type used to admit `'none'`,
a value the schema rejects and the runner never wrote, and lacked the two the
schema allows.
