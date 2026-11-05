---
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/acp": patch
"@e2e-dev/limrun": patch
---

Start faster by loading heavy dependencies when a command or session needs them. The CLI no longer loads the MCP server, the prompt library, or the schema library until `mcp`, `init`, `login`, `logout`, `models`, `explore`, `upgrade`, `doctor`, or `--watch` runs, so `e2e --version` and `--help` take about 25% less time. `@e2e-dev/web` imports Playwright when a browser is first launched or looked up, so a process that only reads the config skips it: `e2e list` on a web project takes about 44% less time, and importing the package half as long. A worker loads Playwright for its first browser instead of before its first test, so that test's reported duration grows by about 0.14 s while the run takes no longer. `e2e/runner` no longer loads the explorer when imported. `@e2e-dev/acp` loads the ACP and MCP SDKs when its first session starts, and `@e2e-dev/limrun` loads `@limrun/api` when its first device is leased.
