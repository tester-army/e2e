---
'@e2edev/web': minor
---

`web.waitForPopup(trigger, options?)` follows a second tab or window. It runs the trigger, waits for the browser context's next page (a `window.open`, a link with `target="_blank"`), waits for it to load, and makes it the attempt's active page: `screen` queries and actions, `web.url()`, `web.title()`, `expect(web).toHaveURL` and `toHaveTitle`, observation, screenshots, video, and dialog handlers all follow it. It returns a `WebPopup` with the popup's `url` and `close()`, which closes the popup and makes the opener the active page again; a popup the app closes itself returns to the opener on its own. The wait takes the given `timeout` or the action timeout, and a trigger that opens no page fails as a download wait does. A page that opens while no wait is pending is left alone, as before. A CDP recovery while a popup is active reattaches to the popup.

A dialog handler's `Dialog` carries `type` (`'alert' | 'confirm' | 'prompt' | 'beforeunload'`), so a handler can route on the kind instead of the message text.
