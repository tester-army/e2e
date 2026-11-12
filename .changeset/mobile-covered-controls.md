---
"e2e": patch
"@e2e-dev/mobile": patch
---

A node agent-device marks as covered now reads as hidden: `toBeVisible` waits, `scrollUntilVisible` keeps scrolling, and `tap({ position })` waits for it to be clear. Role queries still find it unless it is under the soft keyboard, so `getByRole(...).tap()` fails with agent-device's refusal rather than finding nothing. The `e2e/engine` contract now lets an engine keep a node hidden only by a cover in role queries.
