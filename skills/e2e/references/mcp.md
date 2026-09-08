# Working through the MCP server

`e2e mcp` serves the project to a coding agent over MCP (stdio): list the
tests, run a selection, and read a failed run as a digest, without leaving
the conversation.

## Setup

The server ships with `@e2edev/e2e`. `e2e init` offers to register it; by
hand:

```bash
claude mcp add e2e -- npx --no-install e2e mcp          # Claude Code
```

Or declare it in the client's project config (`.mcp.json` for Claude Code,
`.cursor/mcp.json` for Cursor, `.vscode/mcp.json` for VS Code):

```json
{ "mcpServers": { "e2e": { "command": "npx", "args": ["--no-install", "e2e", "mcp"] } } }
```

`--config <path>` names the config file; otherwise the nearest
`e2e.config.ts` is used, and it is loaded again on every call.

## Tools

| Tool | Does |
| --- | --- |
| `list_tests` | What `e2e list` prints, grouped per file: each test with its target and the skip reason when it is skipped. `files`, `tags`, `target` narrow it like the CLI flags. Boots no engine. |
| `run_tests` | Runs a selection exactly like `e2e run` and returns a digest: status, counts, and each failure with its code, message, source line, failing step, agent explanation, and artifact paths. Progress streams while it runs. One run at a time. |
| `read_report` | The same digest for the last `.e2e/report.json`, or a given report path. |

Resources: `e2e://guide` and `e2e://guide/<topic>` hold this skill;
`e2e://report/latest` is the last run's digest.

## Workflow

1. `list_tests` to see what exists and which targets run each test.
2. Write `tests/<feature>.e2e.ts` (topic `writing-tests`).
3. `run_tests` with `files: ["tests/<feature>.e2e.ts"]`, read the digest, fix,
   repeat. `read_report` re-reads the last run without running again.

## Rules

- `run_tests` is the CLI's run: same config, same report, same exit codes.
  A failure comes back as the digest, not as a tool error; a config or
  engine failure comes back as a tool error with the code the CLI prints.
- `REPORT_NOT_FOUND`: no run has happened yet; call `run_tests`.
