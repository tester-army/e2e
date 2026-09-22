---
'e2e': patch
---

`e2e init` scaffolds `openai/gpt-6-luna-fast` as the example model for every gateway, and the docs and skill name it in their examples. On the two agentic suites it passes the same 37 tests as `gpt-5.6-luna-fast` at about a quarter of the cost, with 5 model calls instead of 14 on the lying-labels scenario.
