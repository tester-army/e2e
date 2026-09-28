---
'e2e': minor
---

`getByTestId` takes a RegExp as well as a string, as Playwright's does: `screen.getByTestId(/total-budgeted$/)`. A string still matches the whole id, case-sensitive. Both engines already matched a pattern; only the SDK signature refused one.
