---
'e2e': patch
---

`expect(locator).toHaveAttribute` refuses a secure field with `POLICY_DENIED`, the way `getAttribute()` already did. The engine withholds a password field's `value` attribute, and the matcher read that gap as absent, so `not.toHaveAttribute('value')` passed on `<input type="password" value="...">` and `toHaveAttribute('value')` failed with `observed: attribute "value" absent`. Now the matcher throws before it judges, for every attribute name and negated too, and the message never carries the value. Plain fields are unchanged.
