---
'e2e': patch
---

An operation that times out within a poll tick of the step deadline is `STEP_TIMEOUT`. Its timer and the deadline mark one instant on two clocks, and on a loaded machine the timer fired a few milliseconds before the clock read the deadline as reached, so a `waitFor` polling a page that never changed ended as `ACTION_FAILED` "operation timed out" instead of the timeout that names its last judgment.
