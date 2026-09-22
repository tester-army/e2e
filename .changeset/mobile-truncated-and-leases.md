---
'@e2edev/mobile': patch
---

An observation whose tree agent-device cut, or that is still sparse after the engine's retries, carries `truncated: true`: the agent is told the listing is incomplete (nodes past the cut are on screen but not listed) and a cut screen is never reported to it as unchanged. A hosted device whose lease the engine rejects (no daemon or client configuration, a reserved client key) is still handed to the provider's `release` at the end of the run; before, the run failed and the device stayed allocated. A screen scroll from the agent settles like a tap or fill, and carries the swipe's momentum as agent-device's scroll amount: half the screen for a plain flick, three quarters for a `slow` scroll, the gesture's full reach for `fast`. A `slow` swipe on a node travels three quarters of it too, as on the web engine.
