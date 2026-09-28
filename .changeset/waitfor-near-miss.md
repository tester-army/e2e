---
'e2e': patch
---

A `locator.waitFor()` or `screen.scrollUntilVisible()` that times out carries the locator facts on its `LOCATOR_NOT_FOUND` (locator, role, name, test id, time waited), so the failure lists the closest nodes on screen as the other locator failures do. A near miss also counts a word one typo away from the one asked for (words of four letters or more), so the menu item `Notes` answers a request for `Note` and the button `Submit` one for `Sumbit`.
