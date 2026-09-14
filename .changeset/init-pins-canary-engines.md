---
"e2e": patch
---

`init` pins an engine exactly when the runner it ships in is a prerelease. A canary engine names one runner build in its peer range, and the caret `init` wrote resolved to the newest canary of that engine, whose peer range named a different runner and failed the install.
