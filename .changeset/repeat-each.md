---
'e2e': minor
---

`e2e run --repeat-each <n>` (`RunOptions.repeatEach`) runs every selected test that many times. Each run is a result of its own: `repeat` 0 through `n - 1` on the report result and serial group (0 on every report from now on), an `id` that stays the same for the first run and differs for the later ones, a `(repeat #n)` suffix in the list reporter, JUnit, and the failure pages, and artifacts under a `repeat-<n>` directory. Setup tests run once. Run events `test-started` and `step` carry `repeat`. `--last-failed` names a test once whichever of its repeats did not pass.
