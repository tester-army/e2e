---
'@e2edev/e2e': minor
---

Opt-in run recording. `artifacts` accepts the `video` kind and `e2e run --video` adds it for one run; a recording lands under each attempt's artifact directory, is recorded in `report.json` as an artifact of kind `video` with `startedAt` (the recording's first frame, so step timestamps place onto it), and the failure recap names the file under each failed test. `artifacts.video.retain: 'on-failure'` keeps only the recordings of attempts that did not pass. Video never enters the config digest, so recording a run cannot invalidate its cached traces. Engines record through the new `startVideo`/`stopVideo` pair of `EngineArtifacts`; `run-started` events carry `artifactsRoot`; `StoredArtifact` carries `startedAt` for video. In report-1 every artifact now requires `path`, `size`, and `sha256`; `redaction` says only how much of the file was masked (`incomplete` for a video, which masks nothing) and no longer implies the file was withheld.
