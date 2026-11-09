---
"@e2e-dev/mobile": patch
---

`mobile({ transition })` takes an object, `{ default, gesture, launch }` (the new `TransitionBudgets` type), to set the wait before acting on a control by the kind of the last action. A number still sets the same wait after every action. After a scroll or swipe, a test now acts on a control that came with it only once the control stops moving, at most 4 s after the gesture, and the `gesture` budget is the least wait before that. A control that never stops moving costs the 4 s, or what the action's timeout leaves. A budget of 0 is still no wait at all.
