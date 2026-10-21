---
"e2e": patch
---

The e2e skill now tells a coding agent how to fix a failed test: from the terminal's failure block and the trace page, every line that evidence covers in one pass, and the lines after the failure checked before the next run. When it needs a screen the evidence doesn't show, it goes straight to that screen's URL in an MCP session instead of walking the flow again from the start.
