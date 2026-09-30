---
'e2e': minor
---

`getByRole` takes the accessible name as its second argument: `screen.getByRole('button', 'Sign in')`, a string or a `RegExp`, with the other options after it (`getByRole('button', 'save', { exact: false })`). The object form, `getByRole('button', { name: 'Sign in' })`, still works. The `e2e mcp` `locate` tool writes the short form.
