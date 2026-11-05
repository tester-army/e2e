---
"e2e": patch
"@e2e-dev/web": patch
---

`tap({ position })` measures the offset from inside the node's border, as Playwright's `click({ position })` does. Before, a bordered element shifted the tap by its border width. Engines can report that point as the new optional `SemanticNode.origin`.
