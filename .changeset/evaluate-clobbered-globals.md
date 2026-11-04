---
"@e2e-dev/web": patch
---

`browser.evaluate` returns its result when the evaluated code deletes or replaces page globals such as `Map` or `Object`, and on pages that delete `Array` or `JSON`.
