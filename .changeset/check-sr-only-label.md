---
"@e2e-dev/web": patch
---

`check`, `uncheck`, and `tap` click a checkbox or radio that `sr-only` or `visually-hidden` shrinks to a clipped pixel, the usual toggle-switch markup, through its own label instead of failing with `intercepts pointer events`. `uncheck` still refuses a native radio without clicking it.
