---
'e2e': patch
---

Locator matchers honor Playwright's `{ checked: false }`, `{ enabled: false }`, `{ visible: false }`, and `{ attached: false }`, which flip the matcher, and `{ ignoreCase }` on `toHaveText`, `toContainText`, `toHaveAccessibleName`, and `toHaveAttribute(name, value)`. Before, these were ignored at runtime, so `toBeChecked({ checked: false })` passed on a checked box and `not.toContainText('error', { ignoreCase: true })` passed on `Error`. Any other option key, or a flag that is not a boolean, is now `INVALID_ARGUMENT` before the first read, from JavaScript too.
