---
'e2e': minor
---

Anonymous telemetry covers `e2e mcp` and `e2e explore`. Each MCP session sends one `e2e_mcp_session` event when it closes or fails to open: the client's self-reported name and version, the platform and engine, how it ended, and its tool calls counted by the runner's own tool names with the error codes they failed with. `e2e_run_completed` adds `command`, counts and option ids of the config features the run used, and for `e2e explore` why it stopped and its steps and findings by kind and severity. No names, arguments, results, goals, or findings are sent. The notice shows again once; `E2E_TELEMETRY_DEBUG=1` prints every event, and the opt-outs are unchanged.
