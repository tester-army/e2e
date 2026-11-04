---
"@e2e-dev/web": patch
---

The screen the trace records after each action no longer reads and disposes an element handle for every node on the page, which made every attempt slower under the default `retain-on-failure` trace. The trace shows the same screens; observations the agent and `browser` fixture act on are unchanged.
