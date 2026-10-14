---
"e2e": minor
---

`E2E_CACHE_DIR` and `e2e run --cache-dir <dir>` (also on `e2e cache`) replace `cache.dir`, so checkouts and worktrees of one project can share a replay cache without editing the config. The flag wins over the variable, both resolve from the project root with `~` or a leading `~/` as the home directory, and the cache mode stays as configured. With a custom `cache.store`, `--cache-dir` is an error and `E2E_CACHE_DIR` is ignored.
