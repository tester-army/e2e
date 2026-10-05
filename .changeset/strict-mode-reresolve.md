---
'@e2e-dev/web': patch
---

An action whose locator gains a second match just before it runs, such as a screen transition that briefly shows the old and new page together, no longer fails with `ENGINE_FAILURE` and a Playwright strict mode violation. The locator resolves again: two matches still fail with `LOCATOR_AMBIGUOUS`, and a duplicate that went away lets the action run. A drag whose drop target gains a second match after the press fails with `ACTION_FAILED` and is not repeated.
