---
'@e2edev/e2e': patch
---

Reject `app.screenshot()` with `POLICY_DENIED` after a secret fill. The runner now stops before engine capture or artifact registration so secrets echoed outside secure fields cannot enter explicit screenshot artifacts.
