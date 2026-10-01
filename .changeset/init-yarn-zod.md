---
"e2e": patch
---

`e2e init` adds `zod` next to `ai` when it sets up a model gateway. `zod` is a peer of `ai` and every provider package; npm and pnpm install peers on their own, Yarn does not, so a Yarn project failed to load the generated config with `CONFIG_LOAD_FAILED`. A project scaffolded before this fix needs `yarn add -D zod`.
