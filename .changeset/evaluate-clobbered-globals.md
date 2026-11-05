---
"@e2e-dev/web": patch
---

`browser.evaluate` returns its result when the evaluated code deletes or replaces page globals such as `Map` or `Object`, and on pages that delete `Array` or `JSON`. When a page replaces a built-in the engine's in-page code needs, such as `Map`, later evaluates and locators fail with `EVALUATE_FAILED` instead of `ENGINE_FAILURE`.

`browser.evaluate` now returns plain JSON only. A class instance such as a `DOMRect` or an element fails with `INVALID_ARGUMENT` instead of arriving as a partial object; return `rect.toJSON()` or the fields you need.
