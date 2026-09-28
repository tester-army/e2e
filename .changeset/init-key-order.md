---
'e2e': patch
---

`e2e init` keeps an existing `package.json` in the order the project wrote it. Parsing put the fields it validates first, so `scripts` and `devDependencies` moved to the top of the file and the diff rewrote the whole manifest. New dependencies join a sorted `devDependencies` block in order.
