---
"e2e": patch
---

The bundled agent skill now keeps an `e2e mcp` session open between test runs while the agent writes or fixes a test on the web, so a live look after a failed run goes straight to the screen in that session instead of opening a new one. It says when a run can go beside the session: with no `app.command`, with a port-0 URL (unless the dev server allows one copy per directory, as `next dev` does), or with `reuseExisting: true` on a fixed port. A fixed port without `reuseExisting` makes the run fail with `APP_ALREADY_RUNNING`, so the agent offers `reuseExisting: true` to the user instead of adding it, and closes the session before each run until then. With `reuseExisting` and `CI` set, it unsets `CI` for the run or closes the session. On mobile it closes the session before each run. The MCP server page shows the same cases as a table.
