---
"e2e": patch
---

The bundled agent skill's bug-bash config template now selects the repro tests when the project's own `tests` glob excludes the repro directory. A `!` exclusion applies whatever its order, so a base config that keeps failing repros out of the merge-gating run (`!tests/bugbash/**`) also hid the repro from the bug-bash config, and listing it by path exited `NO_TESTS`. The template drops a base exclusion that hides the repro directory and keeps every other one.
