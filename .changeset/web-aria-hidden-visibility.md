---
'@e2edev/web': patch
'e2e': patch
---

A node under an `aria-hidden="true"` ancestor reads as hidden in every read. The tree walk already skipped the subtree, but a single-node read checked the element's own attribute only, so `toBeVisible` passed on text the snapshot never showed. One predicate now serves both, and a `visible` query narrows by the same rule before a scope, filter, or index.

A `hidden` verdict says why when the cause is not layout. `SemanticNode` gains an optional `hiddenBy`, the platform's term for what excludes the node from its accessibility tree (`aria-hidden` on the web), and a failure on text plainly on screen reads `observed: states: hidden by aria-hidden` instead of `states: hidden`. Assert such a header by `getByRole('link', { name })`.
