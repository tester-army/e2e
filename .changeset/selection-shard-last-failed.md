---
'e2e': minor
---

`e2e run` and `e2e list` take `--last-failed` and `--shard <index/total>`. `--last-failed` selects only the tests the previous run did not pass, read from the `report.json` the run overwrites: failed, timed out, interrupted, or skipped because a setup, a serial predecessor, a hook, or the worker failed; no report to read is the new `NO_LAST_RUN` error. `--shard 2/3` runs one contiguous slice of the selected tests, cut once every other filter applied, never splitting a serial group and bringing only the setup tests the slice needs. `RunOptions` and `ListOptions` carry them as `lastFailed` and `shard`.
