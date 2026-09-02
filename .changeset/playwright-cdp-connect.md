---
'@e2edev/playwright': minor
---

`playwright({ connect })` attaches to a remote browser over the Chrome DevTools
Protocol instead of launching a local one. `connect.cdpEndpoint` is an async
resolver called at worker init, and again on any reconnect, so a hosted browser
whose endpoint is provisioned per run — a cloud session URL not known at config
load — resolves each time the pool needs it. CDP attach is chromium-only (the
factory rejects another engine as `INVALID_CONFIG`), a local launch skips the
browser-install step it no longer needs, and disposing the backend detaches the
CDP session without killing the remote process the host owns.
