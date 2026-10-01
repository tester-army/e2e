---
"e2e": patch
"@e2e-dev/github": patch
---

`--last-failed` no longer goes green on tests it never ran. It reruns tests `--max-failures` skipped, and a test or failed `beforeAll`/`afterAll` another filter leaves out stays owed in the report's new `run.carried` until a rerun runs it. A rerun also keeps the artifacts of the run it reruns and writes its own under `artifacts/rerun-<n>/`, so the folded pull request comment keeps its evidence and stays red while anything is owed.
