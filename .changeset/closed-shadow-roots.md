---
"@e2edev/playwright": minor
---

Observations now include the contents of closed shadow roots. A context init
script wraps `Element.prototype.attachShadow` before any page script runs and
records each closed root by its host; the in-page reader walks those roots
exactly like open ones. Third-party storefront widgets (returns, upsell,
consent) render checkout buttons and links this way, and until now a person
saw them while the agent's tree did not, so every model scrolled for a control
that could not appear until the step budget ran out. Node ids and refs work
inside these roots as everywhere else, so `tap`, `fill`, and the other actions
reach them. Playwright locators (`screen.getByRole`) still cannot, as before.
A secure field inside a closed root is marked `secure` in the tree but cannot
be masked in pixels, so the runner withholds the screenshot for that
observation rather than risk an unmasked password. Declarative
`<template shadowrootmode="closed">` roots are not attached by script and stay
out of reach.
