---
'e2e': minor
---

Tags travel with a test past selection. `e2e list` prints each tag the test declares after the target (`tests/a.e2e.ts › signs in [web] #smoke`) and `--reporter json` gives every pair a `tags` array. The report's `run.results[]` carry `tags` when the test declares any, so a reporter can group results by tag. Report schema: a result gains an optional `tags` array of distinct non-empty strings.
