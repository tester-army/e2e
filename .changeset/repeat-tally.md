---
'e2e': minor
---

A `--repeat-each` run ends with a `Repeats` row in the `list` summary (`1 of 2 tests passed all 5 runs`) and one line per test that did not pass every run, naming each run that failed and its error code (`3/5 passed · repeat 1 ASSERTION_FAILED · repeat 3 flaky (STEP_TIMEOUT)`). The `markdown` page carries the same tally. A flake, and the fix for it, now read as a pass rate instead of results to count.
