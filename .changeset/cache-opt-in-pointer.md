---
"@e2edev/e2e": patch
---

`e2e init` prints a pointer to the new "Commit your traces" section of the
config reference when it adds `.e2e/cache/` to `.gitignore`. Committing cache
entries is opt-in; the section says how to opt in and what CI does with a
committed cache.
