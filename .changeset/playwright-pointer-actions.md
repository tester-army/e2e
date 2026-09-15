---
'@e2edev/playwright': minor
---

Declares every pointer action at a bare point (`performAt` with the full `POINTER_ACTION_KINDS`): a click, double click, right click, held click, hover, drag between two points, and a wheel gesture from a point. `secondaryTap` on a node is a right click. Nodes report `pressed` from `aria-pressed` and `level` for headings (`aria-level`, else the `h1` through `h6` digit), and a role query passes `pressed` and `level` through to the browser.
