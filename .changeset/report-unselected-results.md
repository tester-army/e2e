---
'e2e': patch
---

A test the selection left out (a file no positional named, a tag filter, a platform it does not declare) no longer appears as skipped on the markdown page or in JUnit: `e2e run tests/regression` reported every agent test as `skipped: file not selected by a positional argument` and counted them in the headline. Each result in `report.json` now carries `selected`, the flag the summary's `selected` count and the terminal already used; the page and JUnit render only selected results, and read a document without the flag as all selected. `toBeHidden` reports `visible` as what it observed instead of the node's states.
