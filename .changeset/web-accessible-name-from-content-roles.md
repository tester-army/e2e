---
'@e2edev/web': patch
---

The reader names every role accname names from content: a `<div role="checkbox">`, `role="radio"`, or `role="switch"` reads its text, a table cell, gridcell, row, or header reads its content, and a custom element with `role="button"` reads the text behind its shadow root, slots resolved the way the page composes them. An `<input type="reset">` reads its value, or `Reset` without one, as `type="submit"` reads `Submit`. Before, `getByRole('checkbox', { name })` resolved such a control while `toHaveAccessibleName('')` passed on the same locator and the agent saw an unnamed control; both now report the name Playwright's role selector matched.
