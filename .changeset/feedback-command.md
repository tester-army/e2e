---
'e2e': minor
---

`e2e feedback` sends a bug report, docs problem, or feature request to the e2e team: `e2e feedback --type bug -m "..."`, with optional `--task`, `--expected`, `--actual`, `--approach`, `--command`, and `--agent`. The report goes to PostHog as one event with the anonymous machine facts telemetry carries; secret-named environment variable values and well-known token shapes are redacted first, and `--dry-run` prints the event without sending it. A saved `e2e telemetry disable` does not stop it; `E2E_TELEMETRY_DISABLED` and `DO_NOT_TRACK` do, with exit 2. The skill tells coding agents when to use it. `e2e telemetry` now says "No usage data is sent from this machine." when telemetry is off.
