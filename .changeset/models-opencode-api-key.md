---
"e2e": patch
---

`e2e models opencode-console` lists the ids `OPENCODE_API_KEY` serves when that key is set and no Console login is stored, the same credential `opencodeConsole()` uses in place of the login. Before, the CI path the docs recommend could not discover the ids its key served, and the command reported no credentials while a working one was set. A stored login still wins when both are present, and the no-credentials message now names the key. A login that is stored but rejected no longer names the key either, since this command keeps reading the stored login and would ignore it.