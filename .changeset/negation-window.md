---
'e2e': patch
'@e2edev/web': patch
---

A negated matcher whose negation begins late in the budget passes instead of failing at the deadline: `not.toBeVisible()` on a toast that goes away 4.5 s into the default 5 s budget failed with `observed: no node`, and `not.toBeVisible({ timeout: 800 })` could not pass on a node still shown at the first poll, since the window it had to hold for was the whole budget. The negation now has to begin by the timeout and then hold for the negation window, 1000 ms or half the budget when that is shorter, and the wait runs at most one window past the timeout. A negated matcher that still fails while its negation holds says so beside what it observed: `held for 300 ms, short of the 450 ms negation window`. `expect(web).not.toHaveURL`, `toHaveTitle`, and `toHaveClass` follow the same rule; an engine's `pollCondition` call receives the deadline in force in `evaluate` and the negation state in `onTimeout`.
