---
"e2e": patch
"@e2e-dev/decision": patch
---

A test filter can score the tests it keeps. `relevance` in its result gives each test a number from 0 to 1, and a run with `--changed-since` starts the files of the likeliest first in each target, in bands at 75%, 50%, and 25%, so a failure shows sooner and `--max-failures` stops earlier. The target with the likeliest file goes first. Inside a band, a run with more than one worker still starts the file the previous run spent longest in first.

`decisionFilter()` now scores every test it keeps: 100% for a test whose file, setup file, or stored screenshots changed, the model's answer for one it judged, and 50% for one it did not judge. It requires e2e 0.23.1 or newer, since an older runner refuses the new `relevance` key and drops the whole filter.
