---
"e2e": patch
---

`CONFIG_NOT_FOUND` for an explicit config path (`--config <path>`, the MCP `open_session` `config` input, or `openHost({ config: '<path>' })`) now names the absolute path it checked and, for a relative path, the working directory it resolved against.
