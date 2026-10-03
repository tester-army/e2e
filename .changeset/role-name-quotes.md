---
"@e2e-dev/web": patch
---

A string role name with a quote (`getByRole('button', { name: "Yes, I'm sure" })`) no longer fails with `InvalidSelectorError` once the locator is chained (`.first()`, `nth`, a filter, or the read itself). The same goes for a `u` or `v` flag RegExp with a quote or `>>` in `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, and `getByTestId`.
