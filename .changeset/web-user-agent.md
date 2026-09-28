---
'@e2e-dev/web': minor
---

web({ userAgent }) sets the `User-Agent` every attempt's context sends and `navigator.userAgent` reports, as Playwright's `use.userAgent` does, for an app that switches into a test mode on a marker in the agent string. A persistent remote context (`connect.reconnectEndpoint`, or a provider with `scope: 'attempt'`) rejects it with `INVALID_CONFIG`, like `headers` and `basicAuth`.
