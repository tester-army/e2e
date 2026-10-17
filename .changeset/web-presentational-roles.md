---
'@e2e-dev/web': patch
---

The tree ignores `role="presentation"` and `role="none"` on a focusable element or one with a global ARIA attribute, and keeps an `<img alt="">` with a `title`, `tabindex`, or global ARIA attribute an `image`, matching `getByRole`.
