---
'@e2edev/e2e': minor
---

`OperationContext.origin` tells an engine who is acting: `'test'` for a test's own deterministic step, `'agent'` for the agent. A step verifies its outcome with `expect`, so an engine may act as soon as the target holds still; the agent reads the screen right after acting, so an engine may wait for the transition to end first. The locator engine marks its calls `test`, the agent loop marks its calls `agent`; an absent origin is treated as the agent's.
