---
"e2e": minor
---

`e2e run --watch` runs the tests, then runs again whenever a test file or the config changes, or a key asks for it: `a` for every test, `f` for the failed ones, `u` to update snapshots, `p` and `t` to filter by file and title, `enter` to rerun, `q` to quit. A saved test file runs whole, under the command line's other filters. Refused in CI.
