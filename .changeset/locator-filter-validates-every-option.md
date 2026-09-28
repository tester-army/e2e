---
'e2e': patch
---

`locator.filter()` fails with `INVALID_LOCATOR` on any key other than `hasText` and `has`, beside a supported key too: `filter({ hasText: 'Invoice', hasNotText: 'Paid' })` used to drop `hasNotText` and match the paid row. `locator.selectOption()` fails with `INVALID_ARGUMENT` before acting on anything but one option (a label string or exactly one of `{ label }`, `{ value }`, `{ index }`): an array of options used to select only its first entry. Option bags checked for unknown keys must be plain objects, and a non-enumerable key counts, so an inherited or hidden key can no longer slip past the check.
