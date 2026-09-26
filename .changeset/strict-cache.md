---
'e2e': minor
---

`--strict-cache` and `cache: { strict: true }` fail a step whose recording exists but no longer replays with `REPLAY_STALE` (exit 2, not retried), instead of handing the step to the agent. A committed recording that a UI change broke used to pass live and spend model calls on every CI run until someone re-recorded it; now it fails in the pull request that broke it. Steps with no recording, retries, and values read off the screen still run live.
