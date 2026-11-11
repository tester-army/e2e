---
"e2e": minor
---

**Breaking:** Replace JSON replay caches with readable YAML, one `.yml` file per test under `cache.dir`. Delete old `.json` and `.replay.ts` caches and run with `cache: 'read-write'` to regenerate. Old formats are ignored, including in strict mode. There is no migration command, `cache.format`, `e2e/replay` API or cache diff command.

Filenames use the test file stem and titles, capped at a word boundary within 40 characters, with a short stable digest suffix only on collision. Each file contains ordered act instructions, params and compact actions, plus the existing replay evidence and validity keys. YAML is parsed as bounded core-schema data, with no tags, anchors, aliases or evaluation. Confirmed writes remain atomic; successful attempts remove obsolete steps, and collection prunes removed tests when it can establish absence. Review changes with Git.

Every recording requires engine, platform, app identity and agent context metadata in `recordedWith`; missing or empty headers are invalid.
