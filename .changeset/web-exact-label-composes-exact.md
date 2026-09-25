---
'@e2edev/web': patch
---

An exact label query stays exact when it composes. `rows.filter({ has: screen.getByLabel('Name', { exact: true }) })` used to match a row whose input is labelled `Last Name` too, because the composed form went through Playwright's substring label match while the standalone query kept its own exact predicate; `.first().getByRole('button', { name: 'Remove' }).tap()` then removed the wrong row. The web engine now registers an `e2e-label` selector engine that runs the same reader in the page, so a `has` filter or a scope built on an exact label matches exactly what the standalone query matches, an aria-hidden required-field marker in the label included.
