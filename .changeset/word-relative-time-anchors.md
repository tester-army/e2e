---
"e2e": patch
---

A step whose end screen shows an age in words, such as `a few seconds ago`, `less than a minute ago`, or `just now`, no longer records it as an end anchor while another stable anchor exists. Before, a replay later in the suite failed its end check, handing the step to the agent or failing it with `REPLAY_STALE` under `--strict-cache`.
