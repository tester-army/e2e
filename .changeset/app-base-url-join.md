---
"e2e": patch
"@e2e-dev/web": patch
---

`app.baseUrl` no longer ends in a slash, so `${app.baseUrl}/api/users` requests `/api/users` instead of `//api/users`. With `test` from `@e2e-dev/web`, `app.baseUrl` is typed `string`, since a `web()` target always declares `app.url`. A test that relied on the trailing slash, such as `${app.baseUrl}api/users` or `new URL('users', app.baseUrl)` on a URL with a path, adds the slash itself.
