---
"e2e": minor
"@e2edev/playwright": minor
"@e2edev/agent-device": minor
"@e2edev/github": minor
---

The runner is published as `e2e`. `@e2edev/e2e` is retired and deprecated on npm; every import, config, and peer range now names `e2e` (`e2e`, `e2e/agent`, `e2e/engine`). The engines and the GitHub reporter declare their peer dependency on `e2e`, so a project on `@e2edev/e2e` must switch the runner to `e2e` when it takes these versions. The CLI keeps its `e2e` bin name.
