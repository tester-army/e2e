---
"e2e": patch
---

Add `onAction` to `agent.act`: a hook that runs after each action once the screen settles, for replayed actions too. Use it to take a screenshot per action.
