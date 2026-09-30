---
"@e2e-dev/github": patch
---

`@e2e-dev/github` installs next to a stable `e2e` again. The published builds pinned their `e2e` peer to one canary build, so `npm install` refused to resolve it against a versioned runner.
