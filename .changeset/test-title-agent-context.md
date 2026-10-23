---
"e2e": patch
---

Put the test's title path in agent context. Under `e2e run`, every `agent.act` turn and every judgment behind `agent.assert`, `agent.waitFor`, and `agent.extract` now reads a `Test: <describe> > <test>` line before the agent's `context` and the test's `agentContext`, and a custom executor gets it in `ctx.agentContext`. The replay cache key leaves the line out, since the test id already names the title, so existing recordings keep replaying.
