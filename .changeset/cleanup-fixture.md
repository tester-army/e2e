---
'e2e': minor
---

A `cleanup` fixture. `cleanup.add(fn)` registers work for after the test: deleting the record the body created through the UI, revoking a token, anything that belongs to one test rather than a fixture. Callbacks run newest first on every verdict (pass, failure, a `test.skip` from the body, a timeout), after the `afterEach` hooks and before the `test.extend` teardowns, so a hook still sees the data and a callback can still use the client that created it. Each callback has its own `cleanupTimeout` budget with working fixtures; one that throws or overruns is recorded under the attempt's `secondaryErrors` in phase `cleanup`, the rest still run, and the verdict stays the test's own. `cleanup` is a core fixture name, so `test.extend` cannot redefine it; `cleanup.add` after the test's cleanup ran is `TEST_SETUP_FAILED`. `Cleanup` and `CleanupFn` are exported.
