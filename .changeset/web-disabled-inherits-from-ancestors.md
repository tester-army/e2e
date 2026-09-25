---
'@e2edev/web': patch
---

A control's `disabled` state is the one the browser applies, not its own attribute alone. A button or field inside a `<fieldset disabled>` reads as disabled unless it sits in that fieldset's first `<legend>`, an `<option>` under a disabled `<optgroup>` too, and `aria-disabled="true"` on an ancestor disables the widgets below it, across a shadow root, until an `aria-disabled="false"` cuts the chain. Before, the engine read `el.disabled` and the element's own `aria-disabled` only, so a fenced button passed `toBeEnabled`, failed `toBeDisabled`, answered `false` to `isDisabled()`, and reached the agent's tree as enabled while Playwright reported it disabled. `toBeDisabled`, `toBeEnabled`, `isDisabled()`, `getByRole(..., { disabled })`, and the agent's observation now agree with Playwright's `toBeDisabled` on the same page.
