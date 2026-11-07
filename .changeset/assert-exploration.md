---
"e2e": patch
"@e2e-dev/acp": patch
---

Add opt-in scrolling exploration to agent.assert with bounded action and model-call budgets. Enforce read-only assertion tools for built-in and custom executors. ACP assertions now deny hover; mutating actions from custom executors fail with POLICY_DENIED during any assertion.
