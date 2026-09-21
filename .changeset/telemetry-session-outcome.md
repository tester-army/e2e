---
'e2e': minor
---

The session telemetry event now says how the command ended: its exit code, its duration, and the runner error code when a run or a listing failed before it could start (`CONFIG_NOT_FOUND`, `INVALID_CONFIG`, ...) or `CLI_USAGE` when the CLI rejected a flag. `e2e init` sends an init event with how it ended and the ids of the engine, the gateway, the skill, the MCP registration, and the install chosen; never a path or an endpoint typed at a prompt.
