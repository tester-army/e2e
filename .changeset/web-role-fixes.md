---
'@e2e-dev/web': patch
'e2e': patch
---

The tree reads three controls the way Playwright's `getByRole` does: a `<select>` showing several rows (`size` above 1) is a `listbox`, an `<input>` whose `list` names a `<datalist>` is a `combobox`, and a `<td>` of a `role="grid"` or `role="treegrid"` table is a `gridcell`. A name read off the tree now finds the control with `getByRole`. A `listbox` counts as a control the agent can act on, as a `combobox` does.
