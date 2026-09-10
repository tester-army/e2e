# Results

One JSON file per bench matrix (`e2e-bench-summary-1`): the per-arm,
per-track aggregates the leaderboard renders, a compact copy of every run
(outcome and error code per task, planted defects found per exploration),
and the provenance (e2e version and commit, task-set version, model ids and
list prices, repeats). Raw reports, AI traces, screenshots, and logs stay
under `.bench/` on the machine that ran the matrix; a run's `cli.log` and
`report.json` are the evidence behind any row here.

Render one with `pnpm --filter @e2edev/bench bench report [file]`.
