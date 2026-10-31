---
"e2e": patch
---

Expose dispatched viewport coordinates in `agent.act`'s `onAction` hook: `point` for `tapAt` and `hoverAt`, and `from`/`to` for `dragAt`, including replay. Node-ID and non-pointer actions omit coordinates.
