---
'e2e': patch
---

Every model call now identifies e2e, whichever provider serves it: the `User-Agent` starts with `e2e/<version> (<platform>; <arch>)` ahead of the AI SDK's own, and `HTTP-Referer: https://tester.army/e2e` with `X-Title: e2e` attribute the traffic on the Vercel AI Gateway and OpenRouter. Before, only subscription logins sent the e2e user agent.
