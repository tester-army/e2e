---
'e2e': minor
---

`e2e/engine` exports `resolveExpression`, the reference locator semantics over a semantic tree. It resolves one `LocatorExpression` over `SemanticNode`s in document order: every query kind, `visible`, scopes, `filter`, and `index`, with `text` and `label` answering the innermost match when a container echoes a descendant's text. An engine whose platform tree is the whole truth calls it instead of interpreting expressions itself. A `selector` goes to the platform hook it takes; a `frame` is `FRAME_NOT_FOUND`.
