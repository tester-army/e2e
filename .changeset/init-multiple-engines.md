---
"e2e": patch
---

`e2e init` lets you select both the web and mobile engines. The engine question is now a multiselect, and `--engine` takes a comma-separated list (`--engine web,mobile`). With both, the config gets a target for each, and the examples go in `tests/web.e2e.ts` and `tests/mobile.e2e.ts`, each test with `requires` so the other target skips it. Selecting no engine replaces the **None** option.
