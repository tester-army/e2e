---
"@e2edev/e2e": minor
---

`e2e list` prints the test-target pairs a run would select, one line per
pair as `file › title [target]`, and exits without starting the app, an
engine, or a worker. It takes the same files and selection flags as `e2e run`
(`--config`, `--target`, `--tag`, `--tag-mode`, `--pass-with-no-tests`);
`--reporter json` prints `{ "pairs": [...] }`.
