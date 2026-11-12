---
"@e2e-dev/web": patch
---

The `browser` fixture drives tabs. A tab the app opens (a `target="_blank"` link, `window.open`, an OAuth popup) joins `browser.tabs()` in the background, and the active tab stays where it was. `browser.waitForPopup(trigger)` runs the trigger and makes the tab it opens active, `browser.newTab()` opens a tab in the same context, and each `BrowserTab` has `url`, `title`, `isActive`, `isClosed`, `activate`, and `close`. When the active tab closes, the tab that opened it is active again, or the tab active most recently when that one is closed too. The agent's `switch_tab` and `close_tab` verbs move between tabs and close them. The web engine needs `e2e` 0.23.1 or newer. [Tabs](https://e2e.com/docs/reference/web#tabs)
