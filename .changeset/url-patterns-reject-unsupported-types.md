---
'e2e': patch
'@e2edev/web': patch
'@e2edev/mobile': patch
---

A URL or text pattern that is neither a string nor a `RegExp` is `INVALID_ARGUMENT`. Before, a Playwright-style predicate read as a regexp with no source, which matches everything: `expect(web).toHaveURL(url => ...)` passed on any page, `web.waitForURL(fn)` resolved at once, `web.waitForResponse(fn)` returned the first response of any kind, `web.route(fn, handler)` intercepted every request, the document included, and `expect(value).toMatch(fn)` passed on any string. A text matcher or query given one, such as `toHaveTitle(fn)` or `getByText(fn)`, threw a raw `TypeError`. `toTextPattern` and `urlMatches` in `e2e/engine` throw the same error, so an engine that uses them refuses such a pattern too. A `RegExp` from another realm is still a `RegExp`.
