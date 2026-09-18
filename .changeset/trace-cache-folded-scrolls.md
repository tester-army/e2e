---
'e2e': minor
---

Consecutive identical scrolls fold into one recorded action with a repeat count, so a list paged to its end no longer overruns the action cap and poisons the trace; replay repeats them with a settled look between, re-finding the list each time. A scroll target a device renamed and renumbered is re-found live by its role and place, and a lost list that covered at least half the viewport when recorded (`spans` on the recorded scroll) scrolls as the viewport, live and on replay; a smaller region hands off.
