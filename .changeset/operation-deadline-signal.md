---
'e2e': patch
'@e2e-dev/mobile': patch
---

The mobile engine now bounds each input (a tap or other node action, a point action, typing, a key, `back`, a keyboard dismissal) by its budget (`actionTimeout`, or the call's `timeout`). An input that outlived it used to hold the step until the test timeout. Now an input sent that does not answer in time fails with `ACTION_MAY_HAVE_COMMITTED`, which the runner never repeats, as on the web engine; one sent with almost no budget left still gets 250 ms to answer. An input the budget ran out before, while its target was still settling, is not sent and fails with `OPERATION_TIMEOUT`. A long press or timed swipe that holds at least as long as the budget left is refused before it is sent, naming the hold and the time left. Reads (observe, locate, the relocation before a tap), launches, artifacts, and `device.*` fixture calls are unchanged: a locator poll still lets its last read finish. The `OperationContext.signal` docs in `e2e/engine` now say what it does: it aborts with the attempt or the running hook, not at `timeoutMs`.
