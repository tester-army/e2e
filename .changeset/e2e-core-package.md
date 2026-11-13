---
'e2e': patch
'e2e-core': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
---

New package `e2e-core`: the engine contract, locators, agent, replay cache, and engine sessions that `e2e` is built on. `e2e` depends on it at the same version, and `e2e/engine` and `e2e/agent` re-export it unchanged. `@e2e-dev/web` and `@e2e-dev/mobile` peer on `e2e-core` beside `e2e`, and import the contract from `e2e-core/engine`, which a third-party engine can now import too.
