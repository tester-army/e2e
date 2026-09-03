---
'@e2edev/e2e': minor
---

The list reporter narrates agent runs live. While a test runs, the status
block shows the active step with an animated spinner and its latest model
turns and tool calls; each finished agent step collapses to one permanent
line with its duration and model-call count. Test result lines and the run
summary report model usage: total tokens and, when the provider bills
per request (AI Gateway), real cost in USD.

Executors can now report per-call cost via `ExecutorModelCall.estimatedCostUsd`;
the built-in tool-loop reads the AI Gateway's per-request cost automatically,
so `--debug` step tables and `report.json` model provenance carry `estimatedCostUsd`.
