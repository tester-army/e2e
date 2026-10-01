---
"e2e": patch
---

An `expect.poll` the test body, a hook, or a fixture teardown returns without awaiting now fails that phase with `STEP_NOT_AWAITED` at the line of the call and is cancelled. Before, the test passed and the poll's timeout failed whichever test ran next, or nothing at all.

A negated `expect(locator)` or `expect(browser)` matcher with a `timeout` under a second now passes when the negation held for the whole budget, even when the first read was slow. Before, the window started when that read returned, so a true negation could time out.
