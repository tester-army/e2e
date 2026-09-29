---
'e2e': patch
---

A model request that gets no response within 120 seconds is aborted and sent again through the transport retries, for `agent.act` turns and the judgments alike, and an `agent.act` step's turns note it (`[loop] turn 2 got no response in 120s: sending it again`). The bound covers the whole request, not only its first byte, so one answer that takes longer than 120 seconds is sent again too. Before, one stalled request held the step until its own timeout: an `e2e explore` step spent 220 of its 240 seconds waiting on a single call. A step the clock ends now keeps the turns that ran in the report and in the `--debug` transcript; before, a `STEP_TIMEOUT` step had none. A turn's loop notes (a resent request, a shrunk history, a forced tool choice refused) are kept in the report after the clipped tool results instead of being clipped off with them.
