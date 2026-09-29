---
'e2e': patch
---

Recording-mode messages say what to write. `artifacts: { kinds: [...], trace: { record: 'retries' } }` names `trace: 'on-all-retries'` instead of `'on'`, and the old trace spellings lifted to where a mode goes (`trace: 'retries'`, `trace: { record: 'retries' }`, `trace: 'all'`, `--trace retries`, `--trace all`) name the mode they meant. A retry `video` mode with `retries: 0` gets the same plan-time notice as `trace`, and under `e2e explore`, which runs once, the notice says to pass `--trace on` or `--video on` instead of setting retries. Removed-key messages read `specVersion was removed: delete it; ...`.
