---
"e2e": minor
---

**Breaking:** Replace JSON replay cache files with deterministic `.replay.ts` declarations using `e2e/replay`. Delete old `.json` cache files and run tests with `cache: 'read-write'` to regenerate. Old files are ignored, including in strict mode. There is no migration command or `cache.format` option. Replay safeguards, atomic confirmed writes, and `e2e cache diff` remain available.
