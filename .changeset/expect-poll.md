---
"@e2edev/e2e": minor
---

`expect.poll(read, options?)` re-reads a value until a value matcher passes,
the asynchronous form of `expect(value)`. Every value matcher is there under
the same name, returning a promise, with `.not` to flip the check. Options:
`timeout` (the config `assertionTimeout`, 5000 ms; capped by the attempt's
own deadline, and 5000 ms in a standalone script), `interval` (100 ms), and
`message`, an extra line in the timeout error. The poll runs on the
attempt's budget and stops at once when the attempt is cancelled or times
out. A `read` that throws is one failing sample and polling continues; one
that hangs is cut at the deadline. The timeout is `ASSERTION_FAILED` with the
last sample in its message; a non-finite `timeout` or `interval` is
`INVALID_CONFIG` before the first read. It is not recorded as a report step.

`expect(value).toMatch(regexp)` now resets a global or sticky regexp before
each test, so repeated checks of the same value agree.

```ts
await expect
  .poll(() => getTest(workspace).then((row) => row?.title), { timeout: 15_000 })
  .toBe('AI checkout regression');
```
