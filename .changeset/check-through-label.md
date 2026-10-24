---
"@e2e-dev/web": patch
---

`check`, `uncheck`, and `tap` reach a native checkbox or radio that its own label covers, or that has no box of its own, as Element Plus draws its radio buttons, radios, and checkboxes, by clicking the label at the control's point; a control covered by anything else still fails `ACTION_FAILED`.
