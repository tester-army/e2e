---
'e2e': minor
'@e2e-dev/web': minor
---

Breaking: Playwright trace recording is removed, and the web engine no longer records traces. `trace` in the config or on a target fails with `INVALID_CONFIG`, a test's or describe's `trace` with `COLLECTION_ERROR`, and `--trace` on `run` and `explore` is refused. To see why a test failed, read its page under `.e2e/failures/<test>.md`, which tells its steps, cache decisions, and screen; set `video` for a recording. For engine authors: `startTrace` and `stopTrace` are removed from `EngineArtifacts`, report-1 drops the `trace` artifact kind, `trace` in `artifactCapabilities`, and the `not-required` redaction, and the `TRACE_WITHHELD` error code is gone. The telemetry event drops `config_trace_modes`.
