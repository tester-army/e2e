---
"e2e": patch
---

The CLI runs on Bun 1.4.3 or newer, with no Node.js installed: `bunx --bun e2e run`, or `bunx e2e run` on a machine without Node.js. Bun loads the config and test TypeScript itself, and the CLI's worker processes, `e2e mcp`'s `run_tests`, and `e2e doctor` run on Bun too. In a Bun project, `e2e init` registers the MCP server with `bunx` instead of `npx`. The [CLI reference](https://e2e.com/docs/reference/cli#bun) lists what differs from Node.js. On an older Bun, the CLI names the version to upgrade to, as it does for an old Node.js; Node.js before 22.15 now gets that message too, instead of one about `module.registerHooks`.
