---
'e2e': patch
---

MCP `locate` no longer sends a `status`, `alert`, or `listitem` name that matches nothing back to the observation as an accessible name. It says that `observe` shows those roles by their text and names the `getByRole(role).filter({ hasText })` and `getByText` calls that match that text. A query that already has `exact: false` is no longer told to loosen the match with `exact: false`.
