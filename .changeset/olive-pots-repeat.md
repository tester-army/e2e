---
'@e2edev/playwright': patch
'e2e': patch
---

Harden the boundary between the runner and an out-of-tree driver.

A driver's `DriverError` is now recognized structurally rather than with
`instanceof`. A driver imported by a config file resolves through a different
module registry than the runner, so the two hold different copies of the class
and `instanceof` misses. Every typed driver failure then lost its taxonomy: a
retryable `NODE_STALE` stopped being retried and surfaced as a generic failure
instead of a recoverable race. This affects any driver package, including
`@e2edev/playwright` whenever a project ends up with more than one copy of
`e2e` resolved.

Builds now clear `dist` before compiling. `tsc` only writes files, so output
whose source has since moved or been deleted survived every later build and was
published: after the Playwright driver moved out of `e2e`, the `e2e` tarball
still carried a full copy of the old `dist/playwright` tree.
