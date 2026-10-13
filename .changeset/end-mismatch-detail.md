---
"e2e": patch
---

An `end-mismatch` cache detail now says which part of the end check failed: recorded nodes that did not show (`missing alert "Acme Notes"`), nodes that should have gone but are still there (`still showing ...`), alerts the recording never saw (`unrecorded alert ...`), or an outcome that already showed before the replay acted. It used to print the first two recorded nodes, whether or not they were on screen.
