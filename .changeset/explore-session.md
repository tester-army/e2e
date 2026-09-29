---
'e2e': minor
---

`e2e explore --session <name>` starts the exploration signed in. The run collects the config's test files, runs the one setup test that declares the session, and restores it into the exploration, as a test with `{ session }` does; the planner and the agent are told they start signed in. A name no setup test declares is `COLLECTION_ERROR` before any app process starts, and that message now lists the sessions the setup tests declare, with the nearest one, for `e2e run` too. A setup that filled a secret keeps the exploration's screenshots withheld; one that signed in without filling one, by setting a cookie say, leaves them available.
