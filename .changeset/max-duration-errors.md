---
'e2e': patch
---

`e2e run --max-duration` above 2147483647 is now a flag usage error naming `--max-duration`, not a config error. In `e2e run`, a test cut short by the time limit or `--max-failures` now says which limit stopped it, such as `run interrupted in phase body: run stopped at its time limit of 60000 ms (--max-duration)`.
