---
"@e2edev/e2e": patch
---

The CLI is documented and registered as `npx e2e`. The `--no-install` flag is gone from the help text, the `e2e init` hints, the MCP server prompt, the `.mcp.json` and `.cursor/mcp.json` entries `init` writes, the skill, and the docs. npx runs the locally installed bin first, so the flag added nothing once the package was a dependency, and the unscoped `e2e` name on npm is the team's own placeholder.
