---
"@e2e-dev/web": patch
---

Answer native dialogs an agent step's own action opens instead of failing its next action. In `agent.act` and its replays, `e2e explore`, and the action tools of an `e2e mcp` session, an alert, a confirm, and a leave-page dialog with no handler are accepted, and a prompt is dismissed. The app log names each one. A dialog belongs to the newest action before it, so one a test's own step opens still fails the next step until a `browser.onDialog` handler takes it, even when an agent step reads the screen in between.
