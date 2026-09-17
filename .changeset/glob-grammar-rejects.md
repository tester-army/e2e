---
'e2e': patch
---

A config `tests` glob spelled in a form the grammar lacks is `INVALID_GLOB` with a hint instead of a pattern that matches nothing: braces, character classes (`[jt]s`), extglobs, a backslash separator, an absolute path, a `..` segment, or a trailing `/` or `.`. A leading `./`, a `.` segment, and a doubled `/` are dropped, so `./tests/**/*.e2e.ts` selects what `tests/**/*.e2e.ts` does, no longer walks `.git` and `.e2e` looking for it, and no longer reports "create tests/example.e2e.ts" beside the files it missed. A positional with braces, brackets, or an extglob gets the same hint instead of being taken for a file name, while an existing file or directory is selected by its path whatever its name is spelled with; positionals already resolved `./`, `..`, a trailing `/`, and absolute paths inside the project. A glob can no longer name a file whose own name contains braces or brackets.
