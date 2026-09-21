---
'@e2edev/mobile': minor
---

Breaking: `mobileTools()` no longer offers `type_text`. The agent's own `type` verb reaches the focused field without a target since the engine declared the `keyboard` capability, and a typed value goes through the grammar there, so the trace cache records and replays it; the project tool bypassed the grammar and ended every replay at a gap. A prompt that named `type_text` should say `type` instead. `alert` says to prefer a listed button, whose tap replays.
