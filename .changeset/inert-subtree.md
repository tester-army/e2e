---
'@e2e-dev/web': patch
---

An `inert` subtree leaves the tree the agent sees, as Chrome's accessibility tree drops it. Its controls take no input, so listing them let the agent aim at a button that ignores every action. Locators and `toBeVisible` read inert content as before.
