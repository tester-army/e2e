---
'@e2edev/e2e': minor
'@e2edev/playwright': minor
'@e2edev/agent-device': patch
---

The app-level `allowedOrigins` is gone. It gated typed navigation only; a click, a redirect, or a popup reached any origin regardless, so the list guarded nothing and had to be spelled out for every subdomain a sign-in flow touched. `app.open()` and the agent's `navigate` now open any http(s) URL; `file:`, `data:`, and `javascript:` stay `POLICY_DENIED`. What stays on the app is where its secrets go: a credential or secret is filled only on a page on the **site** of the engine's `url`, its registrable domain (`auth.example.com` for an app at `app.example.com`; `localhost` and IP literals are sites of their own), and a credential or secret that belongs to a third-party page declares its own exact `allowedOrigins`, which now replaces the site rule for that entry instead of narrowing a list. The browser engine's `headers` reach the site and no other host; `basicAuth` answers a challenge from any origin, as Playwright's own `httpCredentials` does; child frames off the site stay out of observations. `EngineAppInfo.allowedOrigins` became `site?: string`, `EngineAppDeclaration` lost `allowedOrigins`, and `sameSite`/`siteOf` are exported from `@e2edev/e2e/engine`. `playwright({ allowedOrigins })` fails at config load with a message naming the replacement.
