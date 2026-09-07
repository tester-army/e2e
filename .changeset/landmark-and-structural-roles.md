---
'@e2edev/e2e': patch
---

`Role` accepts the landmark roles (`main`, `navigation`, `banner`, `contentinfo`,
`complementary`, `region`), `alertdialog`, and the structural and form roles the
engines already report in observations (`searchbox`, `combobox`, `listbox`,
`option`, `radio`, `list`, `table`, `row`, `cell`, `columnheader`). Scoping a query
to the page's main content or a confirmation dialog no longer needs a platform
selector such as `web.locator('main')` or `web.locator('[role="alertdialog"]')`:
`screen.getByRole('main').getByText('Release website')` is portable. The Playwright
engine resolves every role through Playwright's own accessibility engine, and the
device engine matches the roles its node mapping produces; roles a platform never
reports simply match nothing, as before.
