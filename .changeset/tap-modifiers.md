---
'e2e': minor
---

`tap`, `click`, `doubleTap`, and `secondaryTap` take `{ modifiers: ['Shift'] }`, the keys held for the click, as Playwright's `click({ modifiers })` does: a Shift-click that extends a table selection. An engine opts in with `tapModifiers: true`; on one that does not (the mobile engine), a call with modifiers fails with `UNSUPPORTED_CAPABILITY` before the node resolves instead of clicking without them. An unknown or repeated modifier, or `modifiers` beside `position`, is `INVALID_ARGUMENT`.
