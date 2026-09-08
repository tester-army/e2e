---
"@e2edev/e2e": patch
---

An interrupted run's summary names the interrupt. A Ctrl-C while the services
or the app were still starting lands before test discovery, and the list
reporter used to end such a run with `Test Files  no test files` and
`Tests  no tests executed`, as if the globs had matched nothing. Those rows now
read `none started (interrupted)` and `none executed (interrupted)`; a run cut
after its plan arrived keeps its counters, which already show the shortfall
against the planned total.
