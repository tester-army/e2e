---
'@e2e-dev/web': patch
---

`role="presentation"` and `role="none"` are ignored on a control a person can focus or an element carrying one of the global ARIA attributes Chromium counts for the conflict, so `<button role="none">` reads as a `button` in the tree and keeps its accessible name, and `<a href role="presentation">` stays the link `getByRole` finds. An `<img alt="">` that is focusable or carries an `aria-*` attribute is an `image` rather than decoration. An empty inline link is listed too: a rendered zero-size element a person can focus stays in the tree with its `hidden` state set, so `toBeVisible` calls it hidden while a role or test-id locator still reaches it.
