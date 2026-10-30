---
'@e2e-dev/browserstack': minor
---

**Release:** New package: `@e2e-dev/browserstack`. `browserstack()` leases BrowserStack App Automate real Android and iOS devices for the mobile engine, one isolated agent-device daemon per worker slot. An `https` `app` is uploaded once per run, an attempt's video links BrowserStack's recording of the session, and a release fails the run when agent-device can't confirm it ended the session.
