---
'e2e': patch
---

`expect(locator).toHaveValue` refuses a secure field with `POLICY_DENIED`, the way `inputValue()` already did. The engine withholds a password field's value, and the matcher read that gap as `''`, so `toHaveValue('')` passed on a field that still held a password and a test checking that a sign-in form was cleared could pass falsely; `.not.toHaveValue('')` failed with `observed: value ""` for the same reason. Now the matcher throws before it judges, negated or in list form too, and the message never carries the value. Plain fields are unchanged, and an empty non-secure control still reads as `''`.
