---
"@e2edev/playwright": minor
---

Breaking: `playwright` is no longer installed by this package. It is a peer dependency, `>=1.63.0 <2`, replacing the pinned `playwright` dependency the engine carried. Add it to your project:

```bash
npm install --save-dev playwright
```

An app that already depends on Playwright for its own product keeps its version, one copy in `node_modules`, and one browser cache; before, the engine pulled in a second copy pinned to another revision, and `playwright install` provisioned two browser sets. A version outside the range may be rejected by the package manager as an unmet peer (npm's `ERESOLVE`), so upgrade `playwright` within `>=1.63.0 <2`. The floor is 1.63 because `basicAuth` maps to the per-origin `httpCredentials` list that release added. Projects scaffolded with `e2e init` need no change: init now adds `playwright` alongside the engine.
