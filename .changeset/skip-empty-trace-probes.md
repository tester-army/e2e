---
"@e2edev/e2e": patch
---

Skip the trace cache's final observation when an agent step recorded no actions.
Such steps produce no replayable trace, so they no longer wait for an unused
end-state capture and settling cycle.
