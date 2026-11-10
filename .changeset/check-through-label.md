---
"@e2e-dev/web": patch
---

`check`, `uncheck`, and `tap` click a checkbox or radio hidden under its own label (as in Element Plus) through that label. `uncheck` still refuses a native radio without clicking it. Anything else on top of the point the click lands on still fails `ACTION_FAILED`.
