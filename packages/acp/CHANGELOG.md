# @e2e-dev/acp

## 0.1.0

### Minor Changes

- [#960](https://github.com/tester-army/e2e/pull/960) [`ffed34e`](https://github.com/tester-army/e2e/commit/ffed34e94b9b75867d4526f2b1b92e7a66764c3f) Thanks [@enekesabel](https://github.com/enekesabel)! - **Release:** New package: run `agent.act` and `agent.assert` on your own coding agent over the Agent Client Protocol, signed in with the agent's own login. `claudeCode()` and `codex()` start those agents with e2e's step tools as their only tools; `acp({ command, args })` starts any other ACP agent. Every action goes through the runner, so steps replay from the cache without the agent, and a tool of the agent's own that runs without asking fails the step with `POLICY_DENIED`.

### Patch Changes

- [#1457](https://github.com/tester-army/e2e/pull/1457) [`e3195e3`](https://github.com/tester-army/e2e/commit/e3195e3f79cf7dd845a8ea05bbafa9b30d883c7a) Thanks [@samanyudas](https://github.com/samanyudas)! - A step that starts right after a step that timed out now gets a fresh agent when the old agent runs a tool of its own as it stops. Before, the step failed with `MODEL_PROVIDER_FAILED` ("ACP connection closed"), because it reused the session that tool had closed.
