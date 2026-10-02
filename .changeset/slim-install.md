---
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
'@e2e-dev/github': patch
'@e2e-dev/kernel': patch
'@e2e-dev/eas': patch
---

Installing `e2e` pulls in 29 packages instead of 117 and takes about 31MB instead of 36MB. `e2e mcp` now runs on the split MCP SDK (`@modelcontextprotocol/server` 2.2.0) in place of `@modelcontextprotocol/sdk`, which brought in express, hono, and the rest of an HTTP server stack that stdio never used. The server keeps the same protocol version, so existing clients connect as before. Packages are built and published without sourcemaps, which pointed at a `src/` that was never shipped. Stack traces show `dist/` positions.
