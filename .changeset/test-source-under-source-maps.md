---
'@e2edev/e2e': patch
---

A test's `source` in the report names the `test()` call in the test file again. Under tsx, source maps relocate the runner's own stack frames from `dist/` to `src/`, which the frame filter did not recognize, so every test was attributed to the runner's `registry.ts`: relative to the project when `node_modules` lives inside it, otherwise the file's first line. The GitHub reporter's source links and the JUnit locations follow.
