---
'@e2edev/playwright': minor
---

Video recording. With `artifacts: ['video']` or `--video`, the engine screencasts the attempt's page to `video/video.webm` at the attempt's viewport size, one segment per page: a restart or a state reset opens a new page and continues in `video/video-part<n>.webm`.
