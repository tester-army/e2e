---
"e2e": patch
---

After a secret fill, an agent step whose screen can only be read from a fallback screenshot (`act`, or a judgment with `vision: true`) now fails with `POLICY_DENIED` naming the secret fill, instead of the engine's timeout.
