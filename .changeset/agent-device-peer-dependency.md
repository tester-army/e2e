---
"@e2edev/agent-device": minor
---

Breaking: `agent-device` is no longer installed by this package. It is a peer dependency, `>=0.21.0 <0.22`, replacing the pinned `agent-device` dependency the engine carried. Add it to your project:

```bash
npm install --save-dev agent-device
```

A project that already drives devices with the agent-device CLI keeps its version and one copy in `node_modules`; before, the engine pulled in a second copy pinned to another revision. agent-device is 0.x, where a minor can break, so the range pins the minor the engine was built and tested against, and each agent-device minor widens it with an engine release. A version outside the range may be rejected by the package manager as an unmet peer (npm's `ERESOLVE`). Projects scaffolded with `e2e init` need no change: init now adds `agent-device` alongside the engine.
