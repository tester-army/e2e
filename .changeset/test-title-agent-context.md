---
"e2e": patch
---

Put the test's title path in agent prompts. Under `e2e run`, every step of the built-in agent and every judgment behind `agent.assert`, `agent.waitFor`, and `agent.extract` now opens with a `Test: <describe> > <test>` line, and a custom executor reads the title path as `ctx.attempt.titlePath`. The line goes in the step's prompt, not the system prompt, so provider prompt caching still serves every test of a run, and existing recordings keep replaying.
