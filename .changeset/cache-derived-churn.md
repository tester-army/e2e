---
'e2e': patch
---

A local read-write run no longer rewrites a committed recording whose flow is unchanged. Recordings compared equal only when the rule that flagged a typed run-time value (`derived`) matched too, and that rule follows how the agent read the value on that run (off pixels once, off a node the next), so entries in a committed `.e2e/cache` changed on every run.
