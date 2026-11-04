---
"e2e": patch
---

`e2e run --step` runs the first step, then holds each later step until you press a key, with the keys of `--watch`: Enter runs it, `n` runs the rest of the test, `a` runs the rest of the run, `h` lists the keys, and `q` stops the run with exit 130. Add `--headed` to watch the app between steps. The time a step is held counts toward no timeout, so a test can wait at a prompt past its `timeout` and `maxDuration`. Setup tests, retries, teardown steps, and steps inside an `expect.poll` read run without stopping. `--step` runs one worker and is refused in CI, without a terminal, with `--watch`, with `--workers` above 1, and with the json reporter.
