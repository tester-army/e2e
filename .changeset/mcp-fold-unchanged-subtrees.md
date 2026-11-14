---
"e2e": patch
---

When an action changes most of the screen, the whole-screen fallback now folds large unchanged subtrees (10 or more nodes) to a one-line summary naming the node count and the revision that last listed them in full, instead of repeating them. A fold line never names a revision that only reported the subtree as a change, or that itself folded it. Transcript elision keeps the screens those fold lines depend on, so a folded line never names a screen the model no longer holds. `observe` still returns the complete tree.
