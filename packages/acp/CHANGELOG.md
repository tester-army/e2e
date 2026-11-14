# @e2e-dev/acp

## 0.1.3

### Patch Changes

- [#1761](https://github.com/e2e-inc/e2e/pull/1761) [`f64e7db`](https://github.com/e2e-inc/e2e/commit/f64e7dba8d617a8804cba96cd8c885658db8aca5) Thanks [@jxnxts](https://github.com/jxnxts)! - A step that times out while the agent is still finishing the previous step's turn now fails with its timeout instead of `MODEL_PROVIDER_FAILED`.

## 0.1.2

### Patch Changes

- [#1626](https://github.com/e2e-inc/e2e/pull/1626) [`c9783a0`](https://github.com/e2e-inc/e2e/commit/c9783a0666ffea9af4d156d1154657fb94b4af1b) Thanks [@Varshith-Kali](https://github.com/Varshith-Kali)! - Fix `WORKER_CRASH (EPERM)` on Windows when an ACP session ends: a failed session directory removal no longer crashes the worker and is retried after the agent exits.

- [#1568](https://github.com/e2e-inc/e2e/pull/1568) [`1144df4`](https://github.com/e2e-inc/e2e/commit/1144df4e710a448f0553a9cc8def1fd98aaed3ee) Thanks [@bheemreddy-samsara](https://github.com/bheemreddy-samsara)! - Add opt-in scrolling exploration to agent.assert with bounded action and model-call budgets. Enforce read-only assertion tools for built-in and custom executors. ACP assertions now deny hover; mutating actions from custom executors fail with POLICY_DENIED during any assertion. `createVerdictTool(kind)` drops ASSERTION_INCONCLUSIVE from an act verdict, and `createToolLoopExecutor({ inconclusiveOnOverflow: true })` fails a context overflow as ASSERTION_INCONCLUSIVE instead of shortening the history.

- [#1666](https://github.com/e2e-inc/e2e/pull/1666) [`795f71f`](https://github.com/e2e-inc/e2e/commit/795f71f2ffa6d2d6d38d0de512ce6862b5f6c7dd) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Bump runtime dependencies: `@clack/prompts` 1.9.0, `oxc-parser`, `oxc-transform`, and `@oxc-project/runtime` 0.158.0, `@ai-sdk/provider` 4.0.37, and `@agentclientprotocol/sdk` 2.5.0 (ACP schema v1.30.0).

- [#1712](https://github.com/e2e-inc/e2e/pull/1712) [`97093eb`](https://github.com/e2e-inc/e2e/commit/97093ebed44e5a785395b46cc48dcfda6e2b6a46) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Bump `@agentclientprotocol/sdk` to 2.6.0.

- [#1672](https://github.com/e2e-inc/e2e/pull/1672) [`3735887`](https://github.com/e2e-inc/e2e/commit/373588756937562aa89c7dd7f7995ac6b16db972) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Move GitHub repository metadata and CLI links to e2e-inc/e2e after the organization rename. Register the MCP server as io.github.e2e-inc/e2e.

- [#1715](https://github.com/e2e-inc/e2e/pull/1715) [`be460ec`](https://github.com/e2e-inc/e2e/commit/be460ecd91f4790884a36127310aab0d33853903) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Redact project tool results and errors before the model or AI trace recorder reads them, and redact and bound skip reasons before reporting. Avoid repeated scanning of malformed stack frames and trailing slashes in provider API endpoints. Keep ACP forwarding errors out of HTTP responses while preserving the cause in the runner's redacted failure output.

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
