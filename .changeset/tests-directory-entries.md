---
'e2e': patch
---

A `tests` entry with no wildcard that names a directory is `INVALID_CONFIG` naming the glob to write: `'!tests/wip'` excluded nothing (a glob names files), so write `'!tests/wip/**'`, and an including `'tests'` selected nothing. A file passed to `e2e run` that a `!` entry excludes is `NO_TESTS` naming that entry, instead of offering another file as the one meant.
