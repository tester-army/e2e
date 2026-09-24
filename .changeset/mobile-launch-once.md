---
'@e2edev/mobile': minor
---

`mobile({ launch: 'once' })` launches the app when a worker's first attempt starts and only brings it to the foreground after that, so a test starts where the last one ended and takes the app to the screen it needs, as a Maestro flow does. That saves the relaunch and the cold first observation every attempt paid for, two to three seconds per test. The default, `launch: 'attempt'`, still opens the app fresh every time; `app.restart()` is the fresh start on request.
