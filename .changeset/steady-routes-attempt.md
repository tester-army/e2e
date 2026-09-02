---
'@e2edev/playwright': patch
---

`web.route` registers on the browser context, not the current page: a route
now applies before the first page opens, to popups, and across `app.restart()`,
`app.clearState()`, and session restore, as the attempt-scoped contract in the
spec requires. Previously a stub silently stopped firing after any of those.
