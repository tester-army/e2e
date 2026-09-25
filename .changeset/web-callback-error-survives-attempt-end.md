---
'e2e': patch
'@e2edev/web': patch
---

A `web.route` or `web.onDialog` handler that failed after the test's last step no longer passes the test. The web engine kept such a failure for the next operation to throw, and a test that ended right after the request or the dialog had no next operation, so a failed `expect` inside the handler reported a pass; the same handler followed by a `web.url()` failed as expected. The runner now asks the engine to settle the attempt after the body and again after teardown, before the verdict: a handler still running gets the cleanup budget to finish, and the error it kept fails the attempt with its own code. A dialog handler's classified error (`ASSERTION_FAILED`, `POLICY_DENIED`) also keeps that code now instead of becoming an `ENGINE_FAILURE` infrastructure error, matching route handlers. Engines get an optional `settleAttempt` hook for this.
