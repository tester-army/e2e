---
'@e2edev/web': patch
---

`web.waitForResponse` no longer reads a body the browser could not fetch as an empty string. A server that answers 200 and resets the connection before sending the declared `Content-Length` used to give `text()` an `''` and `json()` a parse error, so a test asserting an empty body passed and a test looking for the transport failure could not see one. The response still resolves with `url`, `status`, and `headers`; `text()` and `json()` now reject with `ACTION_FAILED` naming the cause. A genuinely empty body still reads as `''`.
