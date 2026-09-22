---
'e2e': patch
---

The `e2e` and `e2e/engine` types compile without the optional `ai` peer installed. The config, secrets, and run-event declarations under `dist/` no longer import from `ai`, so a project with a hand-rolled `StepExecutor` and no AI SDK sees no TS2307 from `node_modules/e2e` and needs no `skipLibCheck`.
