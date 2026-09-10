---
'@e2edev/e2e': minor
---

One flow, several personas. The `agent` option on a test or describe block accepts a list, and the test then runs once per agent named, as one result each, in one run. `--agent` takes several names too, comma-separated or repeated: every unpinned test runs once per name, and a pinned list narrows to the names the flag also gives (a pin the flag misses stands whole, so `--agent thorough` still benchmarks a model across everything that has no opinion while every persona stays itself). A serial group runs as one unit per agent and its members share one pin; a setup test runs once per target and pins at most one agent.

Every result and serial group in the report records the `agent` it ran as, and the result id now digests `{ testId, targetId, agent }`, so the id of every result changes once. Reporters tell variants apart: the list reporter appends `[admin]` to a title that ran as an agent other than `default`, JUnit case names carry the same tag, and artifacts of one attempt live under `<target>/<test id>/<agent>/attempt-<n>`. The `run-started` event carries `agents` (a list) in place of `agent`, and `test-started` and `step` events carry the pair's `agent`.
