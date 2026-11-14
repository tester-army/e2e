---
"@e2e-dev/mobile": patch
---

`mobile({ transition })` takes an object, `{ default, gesture, launch }` (the new `TransitionBudgets` type), to set the wait before acting on a control by the kind of the last action. A number still sets the same wait after every action. After a scroll or swipe, a test now waits for a control that came with it to stop moving: the `gesture` budget is the least wait, then the control is read until two reads agree. The wait ends at the latest 4 s after the gesture (the `gesture` budget when that is larger), or sooner when the action's timeout cannot fit another read, and the action then goes ahead on the latest read. A budget of 0 is still no wait at all.
