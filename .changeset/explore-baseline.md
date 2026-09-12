---
'@e2edev/e2e': minor
---

`e2e explore --baseline <report.json>` tells this run's findings apart from
an earlier exploration's. Each finding is labeled `known` when it reads like
one the baseline holds and `new` otherwise, and the record says which
baseline findings were not seen again, so a branch can be read against its
base, or a release against the last, without a model in the comparison: the
match is word overlap over the title and the expected-and-actual text, the
same on every run. The terminal tags each finding as it is reported, adds a
`Baseline` summary row, and lists what was not seen; `run.explore` in the
report gains `baseline` and each finding `novelty` and `baselineFindingId`.
The verdict does not change: any issue found still fails the run. A file that
is not the `report.json` of an explore run is `INVALID_BASELINE`.
