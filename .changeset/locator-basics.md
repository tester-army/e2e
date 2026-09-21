---
'e2e': minor
---

The locator reads and matchers a Playwright user reaches for on day one. `locator.all()` hands back one `nth(i)` locator per current match and `locator.allTextContents()` reads every match's normalized text; both resolve once, without waiting or the exactly-one rule, and answer zero matches with `[]`. `isHidden()` is the negation of `isVisible()` and `isDisabled()` of `isEnabled()`, with the same strictness and the same `POLICY_DENIED` rules on secure fields. `expect(locator).toBeAttached()` waits for one match to exist, hidden or shown, and negated passes once nothing matches. `toHaveText` and `toContainText` take a list: the match count must equal the list length and each match must satisfy the entry at its position, a string exactly, a `RegExp` by test; the failure lists every text observed.
