---
"e2e": minor
---

`e2e run --watch` (`-w`) runs the tests, then runs again whenever a test file, a source file beside the tests, or the config is saved, or a key asks for it, with vitest's keys: `a` or enter for every test, `r` for the current filters, `f` for the failed ones, `u` to update snapshots, `p` and `t` to filter by file and title, `q` to quit. A key during a run cancels it. Refused in CI and with `--reporter json`.
