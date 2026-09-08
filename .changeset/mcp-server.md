---
"@e2edev/e2e": minor
---

`e2e mcp` serves the project to a coding agent over the Model Context
Protocol on stdio: `list_tests` lists the selection `e2e list` prints, per
file, `run_tests` runs a selection through the same runner as `e2e run` with
streamed progress and returns a digest of the report (failures with code,
message, source line, failing step, and artifact paths), and `read_report`
digests the last run from disk. The agent skill is served as resources.
`e2e init` registers the server in `.mcp.json` and `.cursor/mcp.json`, and
`e2e guide mcp` prints the new skill topic.
