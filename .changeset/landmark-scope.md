---
'@e2e-dev/web': patch
---

A `<header>` or `<footer>` inside an element with a sectioning role (`role="article"`, `complementary`, `main`, `navigation`, or `region`) is no longer a page `banner` or `contentinfo` landmark, as inside an `<article>` or `<section>`, which is how HTML-AAM and Playwright's `getByRole` read it.
