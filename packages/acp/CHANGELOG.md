# @e2e-dev/acp

## 0.1.1

### Patch Changes

- [#1491](https://github.com/tester-army/e2e/pull/1491) [`108bc60`](https://github.com/tester-army/e2e/commit/108bc604cdcfcfacc8ab66bd179c408bf6887ccf) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Bump @agentclientprotocol/sdk to 2.2.0, @ai-sdk/provider to 4.0.35, and oxc to 0.156.0.

- [#1516](https://github.com/tester-army/e2e/pull/1516) [`0410fc9`](https://github.com/tester-army/e2e/commit/0410fc9c74ffac45d5174b7a3a5b3e6f15fdf32f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Bump agent-device to 0.21.36, @agentclientprotocol/sdk to 2.4.0, @vitest/expect to 5.1.0, and oxc to 0.157.0.

- [#1576](https://github.com/tester-army/e2e/pull/1576) [`33a1541`](https://github.com/tester-army/e2e/commit/33a154157975bb38a421a912052e4d0e436067c8) Thanks [@kdy1](https://github.com/kdy1)! - Start faster by loading heavy dependencies when a command or session needs them. The CLI no longer loads the MCP server, the prompt library, or the schema library until `mcp`, `init`, `login`, `logout`, `models`, `explore`, `upgrade`, `doctor`, or `--watch` runs, so `e2e --version` and `--help` take about 25% less time. `@e2e-dev/web` imports Playwright when a browser is first launched or looked up, so a process that only reads the config skips it: `e2e list` on a web project takes about 44% less time, and importing the package half as long. A worker loads Playwright for its first browser instead of before its first test, so that test's reported duration grows by about 0.14 s while the run takes no longer. `e2e/runner` no longer loads the explorer when imported. `@e2e-dev/acp` loads the ACP and MCP SDKs when its first session starts, and `@e2e-dev/limrun` loads `@limrun/api` when its first device is leased.

## 0.1.0

### Minor Changes

- [#960](https://github.com/tester-army/e2e/pull/960) [`ffed34e`](https://github.com/tester-army/e2e/commit/ffed34e94b9b75867d4526f2b1b92e7a66764c3f) Thanks [@enekesabel](https://github.com/enekesabel)! - **Release:** New package: run `agent.act` and `agent.assert` on your own coding agent over the Agent Client Protocol, signed in with the agent's own login. `claudeCode()` and `codex()` start those agents with e2e's step tools as their only tools; `acp({ command, args })` starts any other ACP agent. Every action goes through the runner, so steps replay from the cache without the agent, and a tool of the agent's own that runs without asking fails the step with `POLICY_DENIED`.

### Patch Changes

- [#1457](https://github.com/tester-army/e2e/pull/1457) [`e3195e3`](https://github.com/tester-army/e2e/commit/e3195e3f79cf7dd845a8ea05bbafa9b30d883c7a) Thanks [@samanyudas](https://github.com/samanyudas)! - A step that starts right after a step that timed out now gets a fresh agent when the old agent runs a tool of its own as it stops. Before, the step failed with `MODEL_PROVIDER_FAILED` ("ACP connection closed"), because it reused the session that tool had closed.
