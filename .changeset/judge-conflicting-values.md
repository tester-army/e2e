---
"e2e": patch
---

`agent.assert` and `agent.waitFor` fail when what they check appears more than once on screen and one instance contradicts it, such as a correct order summary total next to a wrong pay button total.
