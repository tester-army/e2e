---
'@e2edev/e2e': patch
'@e2edev/agent-device': patch
---

Hooks now run in the order the lifecycle spec defines. `beforeEach` runs outer
scope to inner and `afterEach` inner to outer regardless of where in the file
each scope's hooks were declared; before, a file-level hook declared below a
`test.describe` ran after (or, for `afterEach`, before) the group's own hooks.
A `describe`'s `afterAll` runs when its last test in the realm finishes rather
than when the whole file ends, so one group's teardown no longer lands after a
sibling group's tests. Sibling groups that share a title keep separate hooks.

Each `afterEach` hook gets its own `cleanupTimeout` budget with working
fixtures: after a body timeout, teardown can still drive the app instead of
failing with `operation cancelled`; a hook that overruns its budget fails, its
fixture operations are cancelled, and the next hook still runs. The agent-device
`device` fixture reads that signal per call, so it too keeps working in teardown.

Suite-hook run errors carry a readable `scopeId` (`file` or the group title
path); an `afterAll` failure at file scope no longer writes an empty
`scopeId` the report schema rejects.
