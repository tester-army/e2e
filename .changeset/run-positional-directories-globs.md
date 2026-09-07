---
"@e2edev/e2e": patch
---

`e2e run [files...]` now accepts directories and globs, not only exact file paths. A directory selects every test file the config globs discover beneath it (`e2e run tests/agent`), a glob uses the config `tests` grammar (`e2e run 'tests/**/*.smoke.e2e.ts'`), and a file path still matches exactly. Positionals keep narrowing the config globs and must stay inside the project root. When nothing is left to run, the `NO_TESTS` message names each positional that matched no file, so a mistyped path is visible instead of failing silently.
