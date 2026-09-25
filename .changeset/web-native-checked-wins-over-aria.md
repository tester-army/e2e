---
'@e2edev/web': patch
---

A native checkbox, radio, or option reports the state the browser holds, not a stale `aria-checked` or `aria-selected` on the same element. Before, `<input type="checkbox" checked aria-checked="false">` read as unchecked, so `isChecked()` answered false, `toBeChecked` failed on a checked box, and the inverse markup made `toBeChecked` pass on an unchecked one; the agent's observation carried the same wrong state. The reader now does what Playwright's `toBeChecked` does: the control's own `checked` or `selected` wins, and ARIA fills in only for elements with no native state, such as a `div` with `role="checkbox"`.
