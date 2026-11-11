---
"e2e": minor
---

**Breaking:** Replace JSON replay cache files with deterministic `.replay.ts` declarations using `e2e/replay`. Delete old `.json` cache files and run tests with `cache: 'read-write'` to regenerate. Old files are ignored, including in strict mode. There is no migration command or `cache.format` option. Each test has one file in the cache directory, named by the SHA-256 digest of its collected identity, containing all recorded act steps in order. Completed attempts prune obsolete steps; collection prunes removed tests where absence can be established. Replay safeguards and atomic confirmed writes remain. Use Git to review changes; no cache diff command is shipped.
