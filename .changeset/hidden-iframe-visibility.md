---
"@e2e-dev/web": patch
---

An element inside a hidden `<iframe>` now reads as hidden, cross-origin frames included: `isVisible()` returns false, `toBeHidden()` passes, `getByRole` and `{ visible: true }` skip it, and actions wait until the frame shows.
