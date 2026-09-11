---
'@e2edev/e2e': patch
---

`e2e init` adds `playwright` to `devDependencies` next to `@e2edev/playwright`, which now peers on it instead of installing it. The range is the minor the engine was built and tested against, recorded at build time like the engine ranges; a project that already declares `playwright` keeps its version untouched.
