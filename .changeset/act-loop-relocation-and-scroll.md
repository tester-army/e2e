---
'@e2edev/e2e': minor
---

The act loop re-finds a target that went stale and scrolls further in one call.

- A tap, type, press, or select whose node the engine reports stale is retried on the node the same descriptor matches in a fresh capture, up to twice, before the failure reaches the model. A list that remounts its rows between the observation and the action no longer costs a turn per attempt.
- The built-in agent's `scroll` tool takes `times` (1 to 5) and scrolls three quarters of the box per swipe instead of half; every swipe is one recorded action, and the observation after a scroll waits briefly for a windowed or lazy list to render its next rows.
- Several actions issued in one turn keep addressing the screen the turn saw: an id the newest observation no longer carries, because a look in between renumbered the tree (an engine that mints ids per observation) or the element remounted, is re-found by its descriptor in the newest screen when exactly one node matches.
- A mutating project tool arms the same brief wait as a scroll, so a page that reacts to it is read after the reaction; a secret fill's origin authorization is bounded like the fill itself; pressing a key that only moves focus or the caret (Tab, arrows, Home, End, Page keys) is not reported as a control that did nothing.
- Three failed actions in a row earn the model a notice to change approach; five force the conclusion, the way repeated identical calls already do.
