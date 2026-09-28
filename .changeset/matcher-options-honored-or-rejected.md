---
'e2e': patch
---

Locator matchers honor Playwright's `{ checked: false }`, `{ enabled: false }`, `{ visible: false }`, and `{ attached: false }`, which flip the matcher, and `{ ignoreCase }` on `toHaveText`, `toContainText`, `toHaveAccessibleName`, and `toHaveAttribute(name, value)`. Before, these were ignored at runtime, so `toBeChecked({ checked: false })` passed on a checked box and `not.toContainText('error', { ignoreCase: true })` passed on `Error`. Any other option key, or a flag that is not a boolean, is now `INVALID_ARGUMENT` before the first read, from JavaScript too.

`e2e/engine` exports `rejectUnknownOptions(api, options, known, code?)`, the check the runner's own fixtures use, so an engine refuses an option its fixture methods and matchers do not take the same way.
