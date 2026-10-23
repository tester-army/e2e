---
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

Add `locator.or(other)`, which matches either locator in document order and stays strict when both match. Third-party engines must handle the new `union` kind of `LocatorExpression`.
