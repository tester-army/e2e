---
"@e2e-dev/web": minor
---

**Breaking:** A tab the app opens (a `target="_blank"` link, `window.open`, an OAuth popup) becomes the active tab from the next call on: `screen`, `expect`, the `browser` page methods, and the agent read and act on it. A test that kept working on the opener after such a click now fails at that call; make the opener active again first with its `BrowserTab`'s `activate()`, such as `browser.tabs()[0]` for the attempt's first tab. When the new tab closes, the tab that opened it is active again, or the tab active most recently when that one is closed too. `browser.waitForPopup(trigger)` waits for the tab an action opens, `browser.tabs()` lists the open tabs, `browser.newTab()` opens one in the same context, and each `BrowserTab` has `url`, `title`, `isActive`, `isClosed`, `activate`, and `close`. The web engine needs `e2e` 0.23.1 or newer. [Tabs](https://e2e.com/docs/reference/web#tabs)
