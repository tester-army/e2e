---
"@e2edev/e2e": minor
---

The `E2E_DEBUG` environment variable is gone, and with it the live stderr
stream of agent phases and observations it switched on. The two diagnostics
that stay are the ones the report and the CLI own: `e2e run --debug` for phase
timings, transcripts, and the agent step table, and `e2e run --ai-trace` for
every model call.
