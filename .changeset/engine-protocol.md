---
"e2e": patch
---

Add the engine protocol: `connectEngine`, `serveEngine`, and transports in `e2e/engine` run an engine in another process, on another machine, or in another language over LSP-style JSON-RPC. Every engine built with `defineEngine` now runs through the protocol in process, so the harness drives every engine the same way.
