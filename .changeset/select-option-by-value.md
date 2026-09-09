---
"@e2edev/e2e": minor
---

`selectOption` accepts `{ value }`, the option's `value` attribute, beside the
label (a bare string or `{ label }`) and `{ index }`. Tests that know what the
form submits no longer have to know what the option says.
