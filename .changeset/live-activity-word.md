---
'e2e': minor
---

The live line under a running agent step now says what the step waits on.
`Observing` while the screen is being read, `Acting` while an action lands,
`Thinking` only while the model has the turn, `Replaying` while the trace
cache runs recorded actions. On a device a snapshot or a tap takes seconds,
and those read as model time before. Step progress carries the new signal as
`{ phase: 'activity', activity: 'observe' | 'action' | 'model' }`, announced
as each phase begins; the `event` that follows ends it.
