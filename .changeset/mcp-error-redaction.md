---
'e2e': patch
---

`e2e mcp` now redacts secret values from everything `open_session` and `close_session` return and from its log lines. Before, an engine or app error that carried a configured secret, in a failed open or in a `close_session` "Cleanup:" line, reached the client and stderr verbatim.
