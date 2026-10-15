---
'e2e': patch
---

MCP `locate` advice for a status, alert, or list item with no match now suggests `getByText(..., { exact: false })` when the query used `exact: false`.
