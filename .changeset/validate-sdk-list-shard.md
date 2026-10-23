---
"e2e": patch
---

Reject an invalid `shard` passed to `run()` or `list()` with `INVALID_CONFIG`, enforcing the same numeric bounds as the `--shard` flag. Both shard fields are required.
