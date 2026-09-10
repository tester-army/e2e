---
"@e2edev/playwright": minor
---

Observations now reach two kinds of content a person sees and the tree did not.

Closed shadow roots: a context init script wraps `Element.prototype.attachShadow`
before any page script runs and records each closed root by its host; the
in-page reader walks those roots exactly like open ones. Third-party storefront
widgets (returns, upsell, consent) render checkout buttons and links this way,
and until now every model scrolled for a control that could not appear until
the step budget ran out. Node ids and refs work inside these roots as
everywhere else, so `tap`, `fill`, and the other actions reach them. Playwright
locators (`screen.getByRole`) still cannot, as before. A secure field inside a
closed root is marked `secure` in the tree but cannot be masked in pixels, so
the runner withholds the screenshot for that observation rather than risk an
unmasked password. Declarative `<template shadowrootmode="closed">` roots are
not attached by script and stay out of reach.

`display: contents` elements: such an element generates no box, so its empty
client rect list read as hidden and its whole subtree was dropped. Shopify's
one-page checkout form is styled this way, which left every Shopify checkout
without a single field in the tree. The element itself stays out of the tree
unless it carries semantics; its children now decide their own visibility.
