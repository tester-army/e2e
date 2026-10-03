---
'e2e': patch
---

A recorded step that removes a control while something else on screen keeps its text, such as a radio labelled "Express" replaced by a status reading "Express", now replays. Its recording used to fail its own end check on every replay (`end-mismatch`, or `REPLAY_STALE` under `--strict-cache`). Re-record such a step once to pick up the fix.
