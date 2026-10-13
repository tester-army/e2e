---
"e2e": patch
---

The run telemetry event now counts agent steps by entry point (`steps_agent_act`, `steps_agent_assert`, `steps_agent_extract`, `steps_agent_waitfor`) and how many executed tests ran any agent step and how many of those ran `agent.act` (`tests_with_agent_steps`, `tests_with_act`), so the share of tests that are deterministic end to end can be read off a run.
