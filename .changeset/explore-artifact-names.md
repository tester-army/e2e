---
'e2e': patch
---

`e2e explore` writes its artifacts under a short directory named from the goal's first words and a digest of the whole goal, such as `web/explore-check-the-cart-totals-1a2b3c4d5e6f7a8b/default/attempt-0/finding-1.png`. It used the percent-encoded goal, cut at 120 characters, so every finding path in the terminal, `summary.md`, and `report.json` repeated the goal. Ordinary tests keep their directories.
