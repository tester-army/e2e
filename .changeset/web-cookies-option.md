---
'@e2edev/web': minor
---

`web({ cookies })` seeds cookies into every browser context the engine creates, before its first request: a sessionless test's, the one `app.clearState()` opens, and the one a saved session is restored into, where a cookie the session carries under the same name keeps the session's value. The shape is what `web.setCookies` takes; a cookie naming no `url` or `domain` targets the app's `url`. For the notices an app shows every new visitor (a demo banner, a cookie consent, a feedback prompt) whose acknowledgement it stores in a cookie, so no test sets them by hand and no agent step is spent closing them. A malformed cookie is `INVALID_CONFIG` at config load; the option is unavailable with `connect.reconnectEndpoint`, like `headers` and `basicAuth`. `WebCookie` is exported.
