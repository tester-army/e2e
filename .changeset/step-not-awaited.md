---
'e2e': patch
---

A step call without `await` fails the test instead of the worker. A body that returned while a step it started was still running used to end the attempt under that step; the step then failed with nobody to catch it, and the unhandled rejection took the worker down as `WORKER_CRASH`. The runner now checks for running steps whenever the body settles, cancels them, and fails the attempt with `STEP_NOT_AWAITED`, the step recorded as failed and the code frame at the call that lacks `await`. A body that threw keeps its own error; the un-awaited step is recorded under `secondaryErrors`.
