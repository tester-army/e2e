---
"e2e": minor
---

`e2e run --watch` (`-w`) runs the tests, then runs again whenever a test file or the config changes, or a key asks for it, with vitest's keys: `a` or enter for every test, `r` for the current filters, `f` for the failed ones, `u` to update snapshots, `p` and `t` to filter by file and title, `q` to quit; a key during a run cancels it. A saved test file runs whole, under the command line's other filters. Refused in CI.
