---
"e2e": patch
---

The replay end check now waits at least `assertionTimeout` for the recorded end state, so a step recorded on a quiet machine still replays when the machine is busy. Previously the wait was fixed at record time (`Date.now() - lastAction + 10s`), so under load a replay could fail with `end-mismatch` (and `--strict-cache` with `REPLAY_STALE`) although the end state rendered shortly after. A recorded wait longer than `assertionTimeout` is kept, and the wait still polls, so it returns the moment the state holds.
