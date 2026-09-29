---
'e2e': patch
---

A failed agent action no longer reads as done. Its result leads with the tool, what it was aimed at, and the error code, `navigate file:///etc/passwd failed: POLICY_DENIED: forbidden URL scheme: file:`, instead of `Navigated to file:///etc/passwd. failed: ...`, for the testing agent's model and `e2e mcp` alike. Over MCP the result is now an error (`isError: true`), still carrying the screen the action re-observed.
