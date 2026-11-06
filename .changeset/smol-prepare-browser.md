---
"@e2e-dev/smol": patch
---

`prepare` gets a `browser` and `screen` on the warm browser's open tab as its second argument, so a sign-in reads like a test: `prepare: async (_cdpEndpoint, { browser, screen }) => { ... }`. smol detaches them once `prepare` resolves. The DevTools endpoint stays the first argument. Requires `@e2e-dev/web` 0.16.0 or newer.
