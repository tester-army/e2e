---
'@e2edev/playwright': minor
---

An unlabeled text control is now named by its placeholder, in the order
HTML-AAM gives: `aria-label`, `aria-labelledby`, the associated label,
`title`, then `placeholder` and `aria-placeholder`, for text-like inputs and
textareas. A bare search box observes as `textbox "Search"` instead of an
anonymous `textbox`, and `placeholder` joins the attributes an observation
carries, so a cached action recorded against such a field relocates by its
placeholder on replay. An observation that hit the node cap, or could not
enter a child frame within it, now reports `truncated` on the snapshot instead
of ending quietly.
