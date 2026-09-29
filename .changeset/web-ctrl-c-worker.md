---
'@e2e-dev/web': patch
---

A terminal Ctrl-C no longer kills a web worker mid-test. Playwright's own SIGINT and SIGTERM handlers are off, so the runner's interrupt ends the running test as `interrupted` with its attempt, runs its `afterEach` hooks, and disposes the browser, instead of the worker exiting 130 with `WORKER_EXIT` and the test reported `skipped`.
