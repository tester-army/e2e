---
"@e2edev/e2e": minor
---

`app.deepLink(url)` is gone. It was `app.open(url)` under another name: the
same navigation, the same base-URL resolution, the same origin policy, and no
way to open a custom-scheme link, since a scheme outside the allowed origins
fails the policy check. `app.open()` takes the absolute URLs `deepLink` took.
