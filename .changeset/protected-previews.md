---
'@e2edev/playwright': minor
---

`playwright()` takes `headers` and `basicAuth`, so an app behind a gate - a
Vercel preview under deployment protection, an ngrok tunnel with its
interstitial, a staging host behind HTTP basic authentication - is reachable
on every path onto the page, `agent.act` included, where before
only a `web.route` handler in a deterministic test could add a header.
`headers` ride every request bound for an allowed origin and no other, so a
bypass secret never leaves the app it unlocks; `basicAuth` answers a `401`
challenge from an allowed origin only. Both are validated at config load.
