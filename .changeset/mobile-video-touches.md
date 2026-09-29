---
"@e2e-dev/mobile": minor
---

`mobile({ videoTouches: false })` records video without agent-device's touch indicator. Drawing the indicator runs when a recording stops, and on a hosted daemon such as EAS Simulators' it took minutes and failed, so every attempt that recorded video timed out stopping it; without it the stop takes about two seconds.
