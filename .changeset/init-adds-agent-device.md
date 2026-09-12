---
'@e2edev/e2e': patch
---

`e2e init` adds `agent-device` to `devDependencies` next to `@e2edev/agent-device`, which now peers on it instead of installing it. The range pins the minor the engine was built and tested against, recorded at build time like the engine ranges; a project that already declares `agent-device` keeps its version untouched.
