---
'e2e': minor
'@e2edev/playwright': patch
---

`agent.act()` ships on a harness-owned step-executor socket (RFC0001 v0).

The harness owns each planned step — observation redaction, the action
grammar (`tap`, `type`, `typeSecret`, `press`, `select`, `scroll`,
`navigate`), budgets, deadlines, origin policy, and recording — and delegates
only the thinking to a pluggable `StepExecutor` (`agent.executor` in config).
The `e2e/agent` entrypoint exports `createAgent` (the built-in AI SDK
tool-loop executor), `createToolLoopExecutor` (the chassis: verdict tool,
hard stops, loop guards, wind-down, `--debug` transcripts), and `defineTool`
for annotated project tools. Verdicts are ternary: `blocked` is first-class
in the report (step and run status) with a closed category taxonomy
(credentials, environment, seed_data, test_setup, automation). `Secret`
values flow into `act` params as placeholders and fill only through the
authorized `typeSecret` action. With a custom executor, `agent.assert` also
dispatches through the socket.

Breaking changes:

- The AI SDK (`ai`) is now an optional peer dependency (`^7.0.0`) instead of
  a hard dependency. Model-backed calls require it installed; deterministic
  suites and custom executors run without it.
- `reporters` accepts only `'list' | 'json'` (the unimplemented `'html'`
  value is removed) and defaults to `['list']`.
- The `limits` block accepts only enforced keys; the ten
  validated-but-unenforced keys (`maxDiscoveredResults`, `maxArtifactBytes`,
  `maxArtifactTotalBytes`, `maxDownloadBytes`, `maxDownloads`,
  `maxReportBytes`, `maxTerminalFieldBytes`, `maxModelCallsPerStep`,
  `maxActionStepsPerStep`, `maxEstimatedCostUsd`) are rejected.
- `report-1` documents changed (limits/usage blocks, `blocked` statuses, new
  error codes); the conformance `suiteVersion` is now 0.2.0.
- `verifyDriver` and its conformance types are removed from `e2e/driver`
  until the harness can actually run vectors.
