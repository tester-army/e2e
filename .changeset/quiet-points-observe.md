---
"e2e": patch
---

Expose dispatched coordinates in `agent.act`'s `onAction` hook: `point` for `tapAt` and `hoverAt`, and `from`/`to` for `dragAt`, including replay. Coordinates are in the same space as `screen.tapAt` and `boundingBox()`, rounded and clamped to the viewport. Mobile engines only report `point` for `tapAt`. Node-ID and non-pointer actions omit coordinates.
