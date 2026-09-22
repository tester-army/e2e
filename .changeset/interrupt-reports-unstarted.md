---
'e2e': patch
---

An interrupt lands every test the run had not started in `report.json` once, skipped with cause `infrastructure-unavailable` and the reason `run interrupted before execution`, so `--last-failed` after a Ctrl-C or a run-level model failure runs them again along with the interrupted test. A plain interrupt used to drop the queued files from the report, leaving `summary.discovered` short of the plan, and a `--max-failures` limit tripped by a serial group member reported the group's later members twice: once from the group and once more as skipped at the interrupt.
