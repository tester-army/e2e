---
'@e2e-dev/web': patch
---

The web semantic tree lists an inline `<svg>` as an `image`, named by its `<title>` child, as Playwright's `getByRole('img')` and aria snapshot read it. An icon-only control built from an unnamed wrapper and an svg no longer disappears from what the agent sees.
