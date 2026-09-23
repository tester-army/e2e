---
'@e2edev/web': patch
---

`getByLabel` finds a control that `aria-labelledby` names inside a shadow root, open or closed. The reader resolved the referenced id against the document, which never sees a shadow tree's ids, so the control had no label to match: `getByLabel('PIN', { exact: true })` failed `LOCATOR_NOT_FOUND` while `getByLabel('PIN')`, which Playwright matches on its own, resolved, and the observed tree listed the control unnamed. The id now resolves in the control's own tree, where the browser resolves it, so the exact query, `toHaveAccessibleName`, and the tree the agent sees name it alike. `toBeFocused` passes for a control inside a shadow root: `document.activeElement` is retargeted to the outermost host, so no node inside was ever reported focused; the reader now follows each root's `activeElement`, through open roots and the closed roots it records, to the element that holds focus.
