---
"@e2edev/e2e": minor
---

`visible` is the one visibility option on `screen` queries. `RoleOptions.hidden`
is gone: a role query never matches a node hidden from the accessibility tree,
on every engine, the way a browser's role selector never does, and the one
knob that widened it is no longer there to confuse with `visible`, which
narrows every other query kind to nodes on screen. `SemanticQuery.states` on
the engine contract loses its `hidden` key.
