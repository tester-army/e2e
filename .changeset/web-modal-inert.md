---
"@e2e-dev/web": patch
---

The agent no longer sees what is outside a `<dialog>` opened with `showModal()`, which takes no input while it is open, so it doesn't spend an action timeout tapping the page behind a modal. With several modal dialogs open, only the one shown last stays in the tree.
