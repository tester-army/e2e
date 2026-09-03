---
'@e2edev/e2e': minor
'@e2edev/playwright': minor
'@e2edev/agent-device': minor
---

Publish under the `@e2edev` npm scope as restricted (private) packages: the core package `e2e` is now `@e2edev/e2e`, beside `@e2edev/playwright` and `@e2edev/agent-device`. Entry points move with the name (`@e2edev/e2e/agent`, `@e2edev/e2e/backend`, `@e2edev/e2e/run`); the `e2e` CLI binary keeps its name. Provenance is off while the packages are private, since npm only attests public packages.
