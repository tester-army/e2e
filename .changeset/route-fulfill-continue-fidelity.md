---
"@e2e-dev/web": patch
---

`route.fulfill` takes a `Buffer` or `Uint8Array` body and sends the bytes unchanged, and sets every cookie of a `set-cookie` header that joins them with `\n`. A `route.continue` header set to `undefined` is dropped, also on redirects. `WebResponse` adds `body()`, which returns the bytes, so `route.fetch()` and `waitForResponse` can hand binary bodies on.
