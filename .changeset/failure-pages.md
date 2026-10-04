---
'e2e': minor
'@e2e-dev/web': minor
---

Every run writes a page per failed or flaky test under `.e2e/failures/`, and the terminal names it under each failed test (`❯ details .e2e/failures/<test>.md`). Each step on the page shows what it did: the node an action landed on, the values an assertion or `waitFor` read while it waited, the replay cache's decision (where a replay stopped and why, what became of the recording, the entry file), and what the app logged meanwhile: console errors and warnings, uncaught exceptions, failed requests, and 4xx and 5xx responses. The `markdown` reporter now writes only `summary.md`, linked to those pages. A stale recording made from this version on names what changed in its key under `--strict-cache`, such as the engine version. For engine authors: `EngineAttemptContext.appLog` takes what the app logs; report-1 adds `app` events, `step.phase`, and `step.cache.entry`, `detail`, and `write` (report only; `result.cache` from `agent.act()` gains `entry` and `detail`); `FinishedRun.failurePages` maps results to their pages.
