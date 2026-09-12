---
"@e2edev/e2e": patch
---

A test declared through a project helper (`dashboardTest(...)` in
`support/test.ts` wrapping `test()`) reports the helper call in the test file
as its source, so a GitHub comment or JSON report links the test, not the
helper. Before, every such test pointed at the same line inside the helper.
When no frame of the test file is on the stack (the file imports a module that
declares the tests), the declaring module is reported as before. The runner's
own frames and frames under `node_modules` are never a test's source; the
0.10.0 build reported a source-mapped runner frame under `node_modules/.pnpm`
for every test.
