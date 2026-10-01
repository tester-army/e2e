---
"e2e": patch
---

An `expect.poll` that the test body, an `afterEach` hook, or a fixture teardown returns without awaiting is now cancelled and fails that phase with `STEP_NOT_AWAITED` at the line of the call; in a `beforeAll` or `afterAll` hook it fails the hook with `HOOK_FAILED`. Before, the test passed and the poll's timeout failed whichever test ran next, or nothing at all.

The negation window of a negated `expect(locator)` or `expect(browser)` matcher now starts when the first read that saw the negation was issued, not when it returned, so a slow read counts toward it. With a `timeout` under a second, a negation that held for the whole budget now passes at the deadline; before, a slow first read made a true negation time out.
