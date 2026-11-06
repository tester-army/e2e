---
"@e2e-dev/web": minor
---

**Breaking:** `web({ headers })` and `web({ basicAuth })` go only to the app's origin, the scheme, host, and port of `app.url`. Before, `headers` went to every host on the app's site (another port on the same host, sibling subdomains, every host under a shared domain such as `vercel.app`), and `basicAuth` answered a `401` from any origin, so a third-party origin the app embeds could collect the credential.

To migrate, list each other origin that needs the credentials in `credentialOrigins: ['https://api.example.com']`; it covers both. An app whose `app.url` redirects to another origin (`http:` to `https:`, the apex to `www`) needs the origin it lands on listed, or set `app.url` to it. `headers` still ride a request's own redirects to any origin, as before. WebKit can't scope basic auth to an origin on a default port or an IPv6 host, so there it still answers any origin. Update `e2e` with this release: the engine needs the app's origin from the runner.
