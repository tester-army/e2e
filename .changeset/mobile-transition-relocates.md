---
'@e2edev/mobile': patch
---

A test's action on a control that arrived with the last action is aimed where the control landed. The engine waited out the `transition` budget and then acted on the ref it had resolved mid-transition; Android reports a sliding window's frames in flight, so a tap on a modal's button went below the screen and the modal swallowed it. After the wait the control is found again in a fresh snapshot.
