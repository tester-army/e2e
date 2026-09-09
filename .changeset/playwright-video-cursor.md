---
'@e2edev/playwright': minor
---

Video recording. With `artifacts: ['video']` or `--video`, the engine screencasts the attempt's page to `video/video.webm` at the attempt's viewport size (one segment per context: a restart or state reset continues in `video/video-part<n>.webm`), and draws a pointer into the page that glides to each target before a pointer action and pulses on a tap, so the recording shows what acted and where. The pointer lives in a closed shadow root, never intercepts input or appears in observations, and is hidden while model-facing pixels and evidence screenshots are captured.
