---
"e2e": patch
---

A container's key now takes a node's own text before its children's, so a region whose first line is `Count: <output>0</output>` is keyed "Count:" instead of the count. Such a step replays whatever the count reads on the next run; its entry recorded under the old key misses once and records again.
