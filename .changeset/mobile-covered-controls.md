---
"e2e": patch
"@e2e-dev/mobile": patch
---

A node agent-device marks as covered outside the soft keyboard now reads as hidden: `toBeVisible` waits, `scrollUntilVisible` keeps scrolling, and `tap({ position })` waits for it to be clear. Under the keyboard, or on Android while a keyboard agent-device cannot measure may be up, the keyboard's own rules decide. Role queries still find a covered node unless the keyboard hides it, so `getByRole(...).tap()` fails with agent-device's refusal rather than finding nothing. The `e2e/engine` contract now lets an engine keep a node hidden only by a cover in role queries.
