---
'e2e': patch
---

`e2e mcp` notices its client going away. A client that closes stdin, or dies and breaks the pipes, now closes every session, stops the app commands they started, and exits 0. Before, a session kept its browser and app running until SIGTERM or the idle timeout, a server with no session exited 13 with an unsettled top-level await warning, and a write to a dead client crashed with `EPIPE`, leaving the app running so the next session failed with `APP_ALREADY_RUNNING`.
