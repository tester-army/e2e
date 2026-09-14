---
'@e2edev/playwright': minor
---

`web.frameLocator` returns a `FrameScreen`: a `Screen` scoped to the frame
that keeps the two web-only escape hatches. `locator(selector)` reaches a
control inside the frame that has no accessible name, label, placeholder, or
test id, and `frameLocator(selector)` steps into a frame nested in it. Both
compile through the same frame chain as every query in that scope, so
actionability, settle, and `expect` retries apply unchanged. An empty
selector at any level throws `INVALID_LOCATOR`. The portable `Screen` is
untouched; role and label queries remain the first choice wherever the
control has a name.
