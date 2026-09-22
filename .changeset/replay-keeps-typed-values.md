---
'e2e': patch
---

A replayed step keeps its typed values on an app that keeps state between runs. When the value a recording typed (a todo, a note title) was still on screen at the start of the next run, the replay judged it read off the screen and re-staged the step with a `type (run-time value)` gap, so from the third run on the step handed off to the model at that point every time. What a replay types is the recording's own data and is recorded as typed; the check for a value the agent read off the screen applies to the agent's own actions only.
