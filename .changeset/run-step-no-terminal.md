---
"e2e": patch
---

`e2e run --step` works without a terminal, as in a coding agent's shell. The run goes on in the background and the command returns at the first held step, with the screen that step waits on. `e2e run --step next` runs the held step, prints how it ended, and returns at the next one; `e2e run --step rest` runs the rest, and `e2e run --step stop` ends the run. The last answer says the run has ended.
