---
"e2e": patch
---

A replayed `agent.act` step whose end state doesn't show now hands off to the agent once its recorded wait runs out, not after at least 15 seconds, and new recordings no longer count the model's last turn in that wait.
