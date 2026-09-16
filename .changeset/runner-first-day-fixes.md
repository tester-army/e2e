---
'e2e': minor
---

Four fixes from a real suite's first day:

- `e2e run login.e2e.ts` now runs the setup test that produces the session `login.e2e.ts` consumes, wherever that setup lives. Every discovered file is collected; positionals narrow which tests run, and tests in the other files are report-only unselected results. A collection error in any file fails the run, whichever files were named.
- `test.skip(condition, reason)` inside a test body skips the running test for a fact only the app can tell. The steps that ran stay in the report, teardown runs, no retry is spent, and the result is `skipped` with the reason. A setup test cannot skip (`INVALID_ARGUMENT`); outside a body the form is `COLLECTION_ERROR`. Report schema: a skipped attempt may carry steps and a `skip` reason.
- `expect(actual, message)` opens a value failure with the caller's label. `toBeGreaterThanOrEqual`, `toBeLessThanOrEqual`, and `toBeCloseTo(expected, digits = 2)` join the value matchers and `expect.poll`.
- Run-unique string params no longer defeat the trace cache. A string param of three or more characters is a template: the recording stores a placeholder wherever the value appeared (typed text, target names, end anchors, summaries) and replay fills it from the current call, and the cache key digests the params' shape rather than their values. Numbers, booleans, strings under three characters, and secret names stay literal in the key. A string param the recording never spelled out is pinned to its recorded value; a replay with another value misses.
