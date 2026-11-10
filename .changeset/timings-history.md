---
"e2e": patch
---

`e2e run` keeps a small `<output>/timings.json` (schema `timings-1`) of how long each file took, smoothed over recent runs, and starts the longest files first from it when it runs with more than one worker. A CI cache can restore and save just that file, so a fresh checkout gets the ordering; `--timings <file>` moves it. A missing or invalid file is no history, and the previous `report.json` is still the fallback.
