---
"e2e": patch
---

The bundled agent skill now has the coding agent write a test while it walks the flow over `e2e mcp`, instead of exploring first and writing the test from memory. It creates the test file before it opens the session and adds each step as it takes it. A step is an `agent.act` goal, written in the words on screen before the agent walks its path, or, for an exact value, the `Test line:` the action printed. When the outcome shows, the agent locates it and adds the `expect`. The `e2e mcp` server's instructions, `e2e mcp --help`, and the MCP server and coding agents docs say the same.
