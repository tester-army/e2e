---
"e2e": patch
---

`--shard` now reports a skipped test in one shard only, the one that runs the nearest test before it (the first shard when none does). Every shard used to list it, so a skipped test was counted once per shard in the summaries, `junit.xml`, and `report.json`.
