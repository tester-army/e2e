---
'@e2edev/playwright': minor
---

The engine declares `tapAt`: a click at one viewport point in CSS pixels with no
element resolved behind it, which the agent's `tap_visual` uses when the point a
vision model located lands on nothing the tree lists. Nodes inside same-origin
iframes now carry boxes in the top-level viewport's coordinates rather than
their own document's, so a hit test over the screenshot resolves them.
