---
"@e2edev/e2e": minor
---

The `@e2edev/e2e/run` subpath is gone: `run()`, `RunOptions`, `RunOutcome`,
and the event and record types it re-exported. The `e2e` CLI is the one way
to drive the runner. A program that needs a run's outcome runs the CLI and
reads `.e2e/report.json` (report-1), the canonical record of a run. The
config seams stay where they were, in `e2e.config.ts`: `artifacts.store`,
`cache.store`, `agent.executor`, and credential providers.
