---
'@e2edev/mobile': minor
---

An attempt no longer relaunches the pinned app. The worker brings it up once in `prepare`, and a test launches it fresh with `app.open()` when it wants to, so a test starts where the previous one left the app, as a Maestro flow does. Suites that relied on the fresh app every attempt add `await app.open()` as their first line.
