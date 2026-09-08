---
"@e2edev/e2e": patch
---

Two replay misses that were not the app's fault are gone. A target whose
recorded fields matched several controls on the recording screen (one
unlabeled "Set up" button per card, one "Add step" per gap) used to replay as
`target-ambiguous` every time; the recorder now notes the target's `position`
among those twins and a replay honors it when, and only when, the live screen
shows exactly as many. End anchors no longer pick text that cannot read the
same twice, such as a minted key prefix, a countdown, a date, or a clock
time, while a stable anchor exists, so a step whose screen also shows such
values stops handing off as `end-mismatch` on every run.
