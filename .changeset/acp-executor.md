---
"@e2e-dev/acp": minor
---

New package: run `agent.act` and `agent.assert` on your own coding agent over the Agent Client Protocol, signed in with the agent's own login. `acpExecutor.claudeCode()` and `.codex()` start those agents with e2e's step tools as their only tools; `acpExecutor({ command, args })` starts any other ACP agent. Every action goes through the runner, so steps replay from the cache without the agent, and a tool of the agent's own that runs without asking fails the step with `POLICY_DENIED`.
