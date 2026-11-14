---
"e2e": patch
---

When an action changes most of the screen, the whole-screen fallback now folds large unchanged subtrees (10 or more nodes) to a one-line summary naming the node count and the revision they were last seen at, instead of repeating them. `observe` still returns the complete tree.
