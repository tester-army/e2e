---
"@e2edev/playwright": patch
---

`getByDisplayValue(...)` now supports `first()`, `last()`, `nth()`, and `filter({ hasText, has })` in the playwright engine, so a display-value locator can be narrowed, acted on, and asserted like every other query. Positions apply to the value-filtered matches, not to every form control on the page. Previously any refinement failed with `UNSUPPORTED_CAPABILITY: displayValue queries cannot be used as scopes or filters in this engine`. The two compositions Playwright's locator chain cannot express remain unsupported and now say so precisely: a display-value query as the scope of a child query, and as a `has` filter.
