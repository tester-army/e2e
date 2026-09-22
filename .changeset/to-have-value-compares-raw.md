---
'e2e': patch
---

`toHaveValue` compares a form control's value as it is, newlines and trailing spaces included, and prints that raw value when it fails. It used to collapse whitespace on both sides, so `toHaveValue('line1 line2')` passed against a textarea holding `'line1\n\nline2  '` while the failure message showed a string that was never compared. A node with no value, such as a heading, no longer satisfies `toHaveValue('')` or passes `not.toHaveValue(...)` for free: the assertion keeps polling and fails with `observed: no value (not a form control)`. A control the platform reports without a value, such as a cleared field on a device, reads as the empty string. `toHaveAccessibleName` keeps comparing normalized names, as `toHaveText` does, and its failure message now prints the normalized name it compared.
