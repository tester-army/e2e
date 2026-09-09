---
"@e2edev/playwright": patch
---

A control's name and its labels no longer include text marked `aria-hidden`.
A required field whose label ends in a hidden asterisk was named
`"Display name*"`, so `getByLabel('Display name')` and `getByRole('textbox',
{ name: 'Display name' })` found nothing while every screen reader said
"Display name". Names follow the accessible name computation: aria-hidden
subtrees are dropped, CSS-hidden ones stay out as before, and hidden text
between visible fragments is skipped too. Screen text a person reads is
untouched: observations still show the marker. An exact label query is now
decided by the engine over every labelable control in scope, matching any of
the control's labels (an `aria-label`, an `aria-labelledby` target, or a
`<label>`) the way Playwright's `getByLabel` does; as a scope or `has` filter
it composes through Playwright's substring label match.
