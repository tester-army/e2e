---
"e2e": patch
---

The e2e skill now explains what a frame from another site, such as a hosted card field, means for agent steps. The browser engine's semantic tree leaves out that frame's content, so the skill scripts steps there with `browser.frameLocator` and judges the frame with `vision`. An `agent.act` whose only change is inside that frame records no replay and runs live every run.
