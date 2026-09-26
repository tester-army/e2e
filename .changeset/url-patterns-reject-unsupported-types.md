---
'e2e': patch
'@e2edev/web': patch
'@e2edev/mobile': patch
---

A URL pattern that is neither a string nor a `RegExp` is `INVALID_ARGUMENT`. Before, a Playwright-style predicate read as a regexp with no source, which matches every URL: `expect(web).toHaveURL(url => ...)` passed on any page, `web.waitForURL(fn)` resolved at once, `web.waitForResponse(fn)` returned the first response of any kind, and `web.route(fn, handler)` intercepted every request, the document included. `urlMatches` in `e2e/engine` throws the same error, so an engine that uses it for its own URL matcher refuses such a pattern too.
