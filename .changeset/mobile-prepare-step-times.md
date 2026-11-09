---
"@e2e-dev/mobile": patch
---

Log how long each device's prepare steps took: a line such as `iPhone 17 Pro: boot 8.1s, iOS runner 120.3s, open Settings 3.2s` follows each `booting` line, also when a step fails or times out, so a slow engine prepare in the run output shows where the time went.
