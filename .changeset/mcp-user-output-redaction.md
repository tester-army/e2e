---
'e2e': patch
---

`e2e mcp` now redacts secret values from what your code prints through `console`, `process.stdout`, or `process.stderr`, such as a `console.log` in a project tool or in the config's top-level code. Before, it reached stderr verbatim. Output printed while a config loads appears once the config has loaded; if the load fails, that output is withheld, since the config's secrets are unknown. An uncaught error or unhandled rejection is logged redacted and the server shuts down its sessions and exits with code 1, instead of crashing with the raw error.
