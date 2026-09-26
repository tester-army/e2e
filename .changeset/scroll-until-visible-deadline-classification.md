---
'e2e': patch
---

`screen.scrollUntilVisible` fails as `LOCATOR_NOT_FOUND` whenever its deadline is why a swipe ran out of time. Each swipe gets the deadline's remainder as its budget, and an engine honouring that budget can report its timeout a millisecond before the runner's clock reads the deadline as passed, so the same scroll surfaced as `ACTION_FAILED`, or as the engine's raw timeout, depending on which timer woke first. The scroll now owns that outcome, and it dispatches no swipe once less than one poll interval of the budget is left. An engine timing out on its own clock with the deadline still far away stays `ACTION_FAILED`.
