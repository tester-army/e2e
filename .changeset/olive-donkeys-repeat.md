---
'@e2edev/agent-device': minor
'e2e': minor
---

Add `mobile-0.1`: iOS simulator and Android emulator targets, driven by the new
`@e2edev/agent-device` package.

A mobile target names an application instead of a URL, and always names its
driver explicitly - there is no default mobile backend:

```ts
import { defineConfig } from 'e2e';
import { agentDevice } from '@e2edev/agent-device';

export default defineConfig({
  targets: [
    { name: 'ios', platform: 'ios', driver: agentDevice(), app: 'com.example.app' },
  ],
  artifacts: ['screenshot'],
});
```

`screen`, `app`, `expect`, and `agent` are unchanged: a test written against the
portable surface runs on either platform. Device-only power - permissions,
location, push, home, keyboard - lives behind the `device` fixture, the way
browser-only power lives behind `web`. Physical devices are out of profile,
because the state, permission, and push primitives it requires are
simulator-only.

The driver ships as its own package, so a web-only project never installs a
mobile toolchain, and `e2e` itself no longer carries an `agent-device` peer
dependency.

In `e2e` itself:

- Targets, fixtures, artifact validation, and `report-1` provenance understand
  mobile platforms. `trace` stays web-only and `video` is mobile-only, so the
  default `['screenshot', 'trace']` must be narrowed for a mobile target.
- `app.base` is now optional throughout, because a mobile target has no base
  URL. A config with only mobile targets no longer requires `app.url`.
- `e2e/internal` additionally shares `sleep`, `causeMessage`, and
  `sanitizeFilename` with first-party driver packages.
