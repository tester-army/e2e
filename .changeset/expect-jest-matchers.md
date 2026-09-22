---
'e2e': minor
---

Three value matchers a Playwright or Jest test reaches for: `toHaveLength`, `toMatchObject`, and `toHaveProperty` (dotted or array path, optional value), each under `.not` and on `expect.poll`. `expect.any`, `expect.anything`, `expect.objectContaining`, `expect.arrayContaining`, `expect.stringContaining`, and `expect.stringMatching` stand in for values inside `toEqual`, `toMatchObject`, `toContain`, and `toHaveProperty`; they are Jest's matchers with Jest's rules. The unit-runner matchers (`toThrow`, `toBeInstanceOf`, `toStrictEqual`, `resolves`, `expect.extend`) stay out.

`expect.soft(actual)` returns the same matchers for a locator, a `web` fixture, or a value, but keeps a failure on the attempt instead of throwing it. Once the body has settled the attempt fails with one `ASSERTION_FAILED` listing every soft failure in order; a body that throws or times out keeps its own error and records the soft failures under `secondaryErrors`. Outside a test body, in a standalone script or an `afterEach` hook, `expect.soft` throws at once like `expect`.
