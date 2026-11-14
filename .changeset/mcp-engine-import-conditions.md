---
"e2e": patch
---

When an engine package provides separate `import` and `require` entries, the MCP server now uses the `import` entry when opening a session without a config file.
