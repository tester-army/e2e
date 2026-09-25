---
'e2e': patch
---

`expect(locator).toHaveValue`, `toHaveText`, and `toContainText` refuse a secure field with `POLICY_DENIED`, the way `inputValue()` and `textContent()` already did. The engine withholds a password field's value and text, and the matchers read that gap as `''`, so `toHaveValue('')` passed on a field that still held a password and a test checking that a sign-in form was cleared could pass falsely; `.not.toHaveValue('')` failed with `observed: value ""` for the same reason. Now the matchers throw before they judge, negated or in list form too, and the message never carries the value. `toHaveAccessibleName` and the state matchers still answer on a secure field. Plain fields are unchanged, and an empty non-secure control still reads as `''`.
