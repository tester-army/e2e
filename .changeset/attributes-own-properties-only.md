---
'e2e': patch
'@e2edev/web': patch
---

`getAttribute` and `toHaveAttribute` only answer attributes the element carries. The attribute map reached both as a plain object and was read by name alone, so an attribute named like an `Object.prototype` member leaked the member: `expect(button).toHaveAttribute('constructor')` passed on a button with no such attribute, `.not.toHaveAttribute('constructor')` failed with `attribute "constructor" undefined`, and `getAttribute('constructor')` handed back a function instead of `null`. Every read now goes through one own-property lookup, an absent attribute is `null` whatever its name, and a real `constructor="x"` attribute still reads as its string. The web engine builds the map without a prototype for the same reason.
