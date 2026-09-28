---
'@e2e-dev/web': patch
---

`isVisible()`, `toBeVisible()`, and `toBeHidden()` on the web engine read visibility the way Playwright does. The reader used to count an element's client rects, so an SVG with `visibility: hidden`, a box with no width and no height, a button in the folded part of a closed `<details>`, and a `display: contents` element with nothing visible under it were all reported visible while Playwright called them hidden, and `toBeHidden()` failed on a page that showed nothing. Computed style is now read for any element, SVG included, a box is visible only with both a width and a height, closed `details` content outside its `summary` is hidden, and a `display: contents` element is visible when some child element or text is. The same state decides which nodes the agent's screen lists.
