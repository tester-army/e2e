---
"e2e": patch
---

`e2e explore` in a project with no config runs the `e2e init` wizard first instead of failing with `CONFIG_NOT_FOUND`. The exploration starts right after when nothing is left to do by hand: dependencies installed, a model with its key set or its sign-in done, and a web target, whose URL init names. Otherwise init lists the steps left, ending with the `e2e explore` command as typed. Without a terminal, as in CI or under a coding agent, nothing changes: no files are written and the error stays.
