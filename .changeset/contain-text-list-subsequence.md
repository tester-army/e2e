---
'e2e': patch
---

`toContainText([...])` holds when each entry is contained by a distinct match, in order, with extra matches allowed, as Playwright's does. It used to need exactly as many matches as entries, so `not.toContainText(['Deleted item'])` passed on a list of three items where one read `Deleted item`, and `toContainText(['Alpha', 'Gamma'])` failed on `Alpha`, `Beta`, `Gamma`. `toHaveText([...])` still needs the count to match.
