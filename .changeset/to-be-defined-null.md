---
"e2e": patch
---

`expect(value).toBeDefined()` now passes on `null`, as it does in Playwright, Jest, and Vitest; only `undefined` fails it. It used to reject `null` too, so `expect(null).not.toBeDefined()` passed where Playwright fails. `expect.poll(read).toBeDefined()` follows: a read that returns `null` now passes on the first try instead of waiting. For the old non-nullish check, use `toEqual(expect.anything())`.
