---
"e2e": patch
---

`agent.assert` and `agent.waitFor` fail when the value they check is shown more than once and one place contradicts it, such as a correct order summary total next to a wrong pay button total. A claim about some item among several, such as `a todo is marked done`, still holds when one item matches.
