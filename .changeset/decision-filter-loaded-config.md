---
"e2e": patch
"@e2e-dev/decision": patch
---

`decisionFilter` leaves nothing out when the config file the run loaded changed, whatever its name, such as `e2e list --config e2e.ci.config.ts --changed-since origin/main` after an edit to `e2e.ci.config.ts`. A test filter reads that file as `context.configFile`.
