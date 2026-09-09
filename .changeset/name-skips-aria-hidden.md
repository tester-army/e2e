---
"@e2edev/playwright": patch
---

A control's name and its labels no longer include text marked `aria-hidden`.
A required field whose label ends in a hidden asterisk was named
`"Display name*"`, so `getByLabel('Display name')` and `getByRole('textbox',
{ name: 'Display name' })` found nothing while every screen reader said
"Display name". Names follow the accessible name computation: aria-hidden
subtrees are dropped, CSS-hidden ones stay out as before, and hidden text
between visible fragments is skipped too. Screen text is untouched:
`getByText('Display name*')` still finds the label, and a node's `text` still
reads as a person sees it. An exact label query is now decided by the engine
over every labelable element in scope (button, input, meter, output, progress,
select, textarea, and anything with `aria-label` or `aria-labelledby`),
matching any of the element's labels (an `aria-label`, an `aria-labelledby`
target, or an associated `<label>`) the way Playwright's `getByLabel` does; as
a scope or `has` filter it composes through Playwright's substring label match.
