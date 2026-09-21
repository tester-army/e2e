---
'@e2edev/playwright': patch
---

`screen.getByRole('image')` matches: the engine reads an `img` as the contract's `image` role but passed the query's spelling straight to the role selector, which only knows `img`, so an `image` query never found anything.
