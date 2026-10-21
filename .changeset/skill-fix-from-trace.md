---
"e2e": patch
---

The e2e skill now tells a coding agent how to fix a failed test. It fixes from the terminal's failure block and the trace page, every line that evidence covers at once, and checks the lines after the failure before the next run. To see a screen the evidence leaves out, it goes straight there in an MCP session instead of walking the flow again from the start.
