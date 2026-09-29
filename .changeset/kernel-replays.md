---
'@e2e-dev/integrations': minor
---

`kernel()` records an attempt that records video as a Kernel replay of the browser's screen, saved as `video/replay.mp4`. `replay` takes Kernel's start-replay options (`framerate`, `max_duration_in_seconds`, `record_audio`), or `false` for the page screencast; a headless browser, which Kernel cannot replay, gets the screencast. `e2e` is now a peer.
