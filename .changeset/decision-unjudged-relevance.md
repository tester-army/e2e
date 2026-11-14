---
'@e2e-dev/decision': patch
---

`decisionFilter()` takes an `unjudgedRelevance` option: the score given to a test the model did not judge, from 0 to 1, instead of the fixed 50%. It orders the unjudged among the judged files a run starts first.
