---
'@e2e-dev/web': patch
---

A provider with `scope: 'attempt'` no longer fails an attempt at random with `cdpEndpoint reused a browser from a previous attempt`. A service that restores browsers from one snapshot (Kernel does) hands out new browsers whose default context has an earlier one's id; a lease is fresh by the provider's contract, so the engine checks earlier contexts only for `connect.reconnectEndpoint`. The attempt's first page is now the browser's own first tab, navigated to `about:blank`, instead of a second tab beside it, so a hosted browser's live view shows one tab.
