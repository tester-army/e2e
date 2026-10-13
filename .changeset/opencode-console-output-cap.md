---
"e2e": patch
---

`opencodeConsole()` asks for an explicit output cap on the models the workspace config serves over Anthropic. Those ids are unknown to the Anthropic SDK, which limits a call that sets no `maxOutputTokens` to 4096 tokens and only warns: a long answer ended with `finishReason: 'length'` and nothing in the result said why. The provider now asks for 8192, the cap the runner already allows a judgment, and a caller's own `maxOutputTokens` is left untouched.
