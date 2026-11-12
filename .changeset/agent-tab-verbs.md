---
"e2e": patch
---

The agent tells the model when an action opened a tab in the background (`The app opened a new tab (tab 2 of 2). The screen still shows tab 1; use switch_tab to see it.`), names the tab in every screen header while more than one is open (`tab 1 of 2`), and gets `switch_tab` and `close_tab` verbs on engines that declare the new `session.switchTab` and `session.closeTab` hooks. `EngineSnapshot.tabs` reports the open tabs. [Action tools](https://e2e.com/docs/reference/agent#action-tools)
