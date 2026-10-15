---
"e2e": patch
---

The bug-bash skill's config example removes its repro-directory exclusion before adding the repro glob, so projects that exclude `tests/bugbash/` from regular runs can still select bug-bash tests.
