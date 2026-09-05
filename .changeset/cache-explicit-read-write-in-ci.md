---
"@e2edev/e2e": patch
---

CI now demotes the trace cache to `read-only` only when the config left `mode` unset. An explicit `cache: 'read-write'` (or `{ mode: 'read-write' }`) is honored in CI as the project's own statement that it trusts the cache it restores, for example one carried between runs by the CI provider's cache service rather than committed to git. `--no-cache` still wins over the config, and a custom `cache.store` keeps stating its own trust through `writable`.
