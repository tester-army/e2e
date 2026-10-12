---
'e2e': patch
'@e2e-dev/mobile': patch
---

The mobile engine now bounds every operation by its budget (`actionTimeout`, or a call's `timeout`). A device command that outlived it used to hold the step until the test timeout. Now an observation, locate, screenshot, launch, or video call fails with `OPERATION_TIMEOUT`. An input (a tap, a point action, typing, a key, `back`, a keyboard dismissal) fails with `ACTION_MAY_HAVE_COMMITTED`, which the runner never repeats, as on the web engine; one left under 250 ms is not sent and fails with `OPERATION_TIMEOUT`. The `OperationContext.signal` docs in `e2e/engine` now say what it does: it aborts with the attempt or the running hook, not at `timeoutMs`.
