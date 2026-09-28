---
'e2e': minor
---

`artifacts: { trace: { record: 'retries' } }` records a trace only on retries, as Playwright's `on-all-retries` does. A trace on every attempt, still the default, cost about a quarter of the wall time and half again the CPU on a 141-test suite; with `retries` a passing first attempt records nothing, and a serial group's shared trace follows the group's attempts.
