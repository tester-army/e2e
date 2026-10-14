---
"e2e": patch
---

Agent steps on Claude Opus 5.5, Sonnet 5.5, and Fable 5.1 no longer fail with `Invalid signature in thinking block. The block is bound to a different conversation`. These models bind every thinking block to the system prompt and the messages that preceded it, and the act loop edited both mid-step: it rewrote the system prompt when it switched to `auto` after the provider refused or downgraded a forced tool choice (the first step of every worker on these models), and it elided superseded screens and screenshots from earlier messages. The tool-calls-only rule is now part of every step's prompt, and when an earlier message is elided the reasoning after it is not sent again on Anthropic models; the step's turns note it.
