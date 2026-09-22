---
'e2e': patch
---

The run summary's `AI` row names the models the steps reported, each with its call count when several answered (`typesafe-ai/jev (22 calls) · gateway/openai/gpt-5.6-luna (1 call)`), instead of echoing the configured model: a custom executor, an agent pinned to another model, or `--agent a,b` printed a label the per-step `model` records in `report.json` contradicted. The header line under `RUN` still names the configured model and judge.
