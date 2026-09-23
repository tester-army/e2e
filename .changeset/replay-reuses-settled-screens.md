---
'e2e': patch
---

Trace-cache replay runs closer to the speed of the deterministic APIs: the first recorded action relocates on the step's settled start capture instead of capturing the same screen again, the look after a fill no longer spends a beat proving the screen holds still, a folded scroll on a list takes one look per repeat, and a step the cache replayed whole never re-stages its entry, so its file keeps its bytes and `createdAt` and a committed `.e2e/cache/` stays clean across local runs. A typed value now counts as read off the screen only when it is the whole name or text of a control, or a token with a digit in it shown as a word of its own; a plain word the agent composed that also appears inside a sentence on screen ("one" beside "Row one") is recorded and replays instead of ending the recording as a run-time value gap. The `truncated` miss reason in the docs states the actual action ceiling.
