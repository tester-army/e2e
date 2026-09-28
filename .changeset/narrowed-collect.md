---
'e2e': patch
---

A run narrowed by positionals (`e2e run tests/login.e2e.ts`) no longer fails on a test file it did not select that fails to import or register its tests, such as a half-written file elsewhere in the suite: the file is skipped with a notice. A collection error in a selected file, or in any file of an unnarrowed run, still fails the run, and a selected test whose session setup is then missing names the skipped file as where it may be.
