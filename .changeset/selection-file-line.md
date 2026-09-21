---
'e2e': patch
---

A positional may end in `:line` (`npx e2e run tests/signup.e2e.ts:12`, `signup:12`) to select only the test whose `test(` call opens on that line, in every file the positional names; a serial group runs whole when a line names one member, and naming the file without a line selects it whole. When no test is declared at a named line, `NO_TESTS` names the positional and the lines the file declares tests at.
