---
"@e2e-dev/web": patch
---

`expect(browser).toHaveClass` on a node that never arrives still fails as `ASSERTION_FAILED` observing `no node`, now that a locator read waits for its match until the action timeout.
