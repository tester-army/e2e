---
'@e2edev/e2e': minor
---

The act loop re-finds a target that went stale and scrolls further in one call.

- A tap, type, press, or select whose node the engine reports stale is retried on the node the same descriptor matches in a fresh capture, up to twice, before the failure reaches the model. A list that remounts its rows between the observation and the action no longer costs a turn per attempt.
- The built-in agent's `scroll` tool takes `times` (1 to 5) and scrolls three quarters of the box per swipe instead of half; every swipe is one recorded action, and the observation after a scroll waits briefly for a windowed or lazy list to render its next rows.
