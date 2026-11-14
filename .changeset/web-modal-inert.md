---
"@e2e-dev/web": patch
---

Everything outside a `<dialog>` opened with `showModal()` takes no input, so the agent no longer sees it or spends an action timeout tapping it. With several modal dialogs open, only the one shown last stays in the tree; when e2e can't tell which one that is, nothing is left out.
