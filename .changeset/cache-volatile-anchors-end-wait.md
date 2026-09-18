---
'e2e': patch
---

Replays hand off sooner, and less often, on list pages. Pagination ranges (`Showing 1 to 9 of 9 results`), record counts (`12 items`), millisecond timings, and bare numbers such as a badge are no longer recorded as end anchors while a stable anchor exists: they grow with the data every run leaves behind and could never read the same again. A recording's end wait is now measured from its last action to the passing screen instead of from the step's start, so a replay no longer waits out the model's thinking time before handing off.
