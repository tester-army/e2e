---
"@e2edev/playwright": patch
"@e2edev/agent-device": patch
---

Role queries no longer read a `hidden` state from the query: the engine
contract dropped it. Playwright's role locator keeps its default of matching
only nodes exposed to assistive technology; the device engine skips hidden
nodes in role queries as it did by default.
