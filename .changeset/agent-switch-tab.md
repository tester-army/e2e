---
"e2e": patch
---

The agent tells the model when an action opened a tab and the screen moved to it, names the tab in every screen header while more than one is open (`tab 2 of 2`), and gets a `switch_tab` verb on engines that declare the new `session.switchTab` hook. `EngineSnapshot.tabs` reports the open tabs. [Action tools](https://e2e.com/docs/reference/agent#action-tools)
