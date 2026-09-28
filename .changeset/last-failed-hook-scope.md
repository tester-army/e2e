---
'e2e': patch
---

`--last-failed` runs a failed `beforeAll` or `afterAll`'s tests again. A hook failure is a run error no test result carries, so a test whose body passed while its `afterAll` threw was left out of the rerun: the rerun exited 0, or with nothing else failing found no tests. The report's hook error now carries a `scope` beside `scopeId`: its `file`, `targetId`, and describe `titlePath`. `--last-failed` selects every test in that describe or file on that target, and for a setup the tests that consume its session, until a run where the hook passes. A report whose hook error has no `scope` selects every test.
