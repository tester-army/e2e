---
'@e2edev/playwright': patch
---

A role query's `level` (`screen.getByRole('heading', { level: 1 })`) is passed to Playwright's `getByRole`, so a heading level narrows the query on the web.
