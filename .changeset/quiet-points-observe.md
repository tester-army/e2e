---
"e2e": patch
---

Add coordinates to `agent.act`'s `onAction` event: narrow on `event.action` to read `point` for `tapAt` and `hoverAt`, or `from` and `to` for `dragAt`, replay included. Points are in the same space as `screen.tapAt` and `boundingBox()`, rounded and clamped to the viewport.

`ActionEvent` is now a union keyed by `action`, typed `ActionName` or `tool:<name>` instead of `string`. New `ActionName` and `ActionDetails` types.
