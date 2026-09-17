---
'e2e': patch
---

A `tests` glob, or a positional glob, that could never match a file is `INVALID_GLOB` instead of an empty selection: an absolute path, a trailing `/`, braces, a backslash separator, or a `..` segment. A leading `./`, a `.` segment, and a doubled `/` are dropped, so `./tests/**/*.e2e.ts` selects what `tests/**/*.e2e.ts` does, and the run no longer walks `.git` and `.e2e` looking for it or reports "create tests/example.e2e.ts" beside the files it missed.
