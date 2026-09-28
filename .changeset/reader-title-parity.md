---
'@e2e-dev/web': patch
---

A control named only by a descendant's `title`, or by an `aria-labelledby` target holding only whitespace, is named the way `getByRole` matches it. The tree fell back to the title whenever the content trimmed to nothing, while Playwright keeps the untrimmed content, so `<button><div title="Next month" style="display:flex"><svg/></div></button>` read as button "Next month" in the tree and in failure hints but `getByRole('button', { name: 'Next month' })` matched nothing.
