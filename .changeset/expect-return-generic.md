---
"e2e": patch
---

`expect(await response.json()).toMatchSchema(schema)` type-checks: `expect` no longer hands the engine's `json<T>()` a locator type to infer, so the value matchers apply.
