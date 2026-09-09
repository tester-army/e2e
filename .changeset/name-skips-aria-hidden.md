---
"@e2edev/playwright": patch
---

A control's name no longer includes text its label marks `aria-hidden`. A
required field whose label ends in a hidden asterisk was named
`"Display name*"`, so `getByLabel('Display name')` and `getByRole('textbox',
{ name: 'Display name' })` found nothing while every screen reader said
"Display name". Names now follow the accessible name computation and drop
aria-hidden content; a subtree without any keeps innerText's layout-aware
result.
