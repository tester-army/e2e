---
'@e2edev/web': patch
'e2e': patch
---

Judgments, actions, and the trace cache's looks wait out a screen that says it is still loading before reading it. A spinner (`progressbar` with no value), `aria-busy` on the root or a landmark, or a content area that is little more than a `Loading...` or `Please wait` notice is waited through for up to five seconds; a screen still loading after that is used as it is. Before, `agent.assert` after an `act` judged the skeleton and failed as inconclusive, replays handed off with the end anchors missing on a half-loaded page, and a baseline taken before a list rendered recorded the whole table as the step's delta.
