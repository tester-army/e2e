---
'e2e': patch
---

`count()`, `all()`, `allTextContents()`, `isVisible()`, and `isHidden()` answer at once when the frame their locator is scoped to is not in the document: `count()` is `0` and `isVisible()` is `false`, as for zero matches. Before, the first three waited the whole action timeout and then failed with `LOCATOR_NOT_FOUND`, and `isVisible()` threw it immediately, so a `while (!(await widget.isVisible()))` loop against an iframe widget broke on its first pass. Actions and assertions keep polling for the frame. `isVisible()` and `isHidden()` now also re-resolve a node the engine reports stale, within the action timeout, where before they answered from a single attempt and threw `LOCATOR_NOT_FOUND` on a resolve that raced a navigation; a resolve still stale at the timeout throws as before.
