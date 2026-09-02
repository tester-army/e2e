---
'@e2edev/agent-device': minor
---

New package: `@e2edev/agent-device`, the mobile backend for `e2e`, built on
[agent-device](https://github.com/callstack/agent-device). It implements the
public `e2e/backend` contract for iOS simulators and Android emulators the
same way `@e2edev/playwright` does for browsers, and core learns nothing new.

- `agentDevice({ platform, app?, device?, session?, snapshot? })` returns a
  `defineBackend` handle with observation (the accessibility tree projected
  onto the role vocabulary, with a viewport and optional pixels), actions
  (tap, double tap, long press, fill, clear, check, Enter, single-character
  keys, node swipe, drag), location (every `screen` query plus agent-device
  selectors through `screen.locator`), a viewport swipe, `app.back`, and
  `app.restart`/`app.clearState` when `app` is pinned. Screenshots land under
  the attempt artifact directory.
- Trace cache support: the backend reports a location as `app://<app>/<screen
  title>`, so `agent.act` steps record a start and end anchor and replay
  zero-turn on the next run like a web step does. With `app` pinned, the app
  is opened fresh per attempt and a flow needs no agent-side tool at all.
- The contributed `device` fixture: network, airplane mode, permissions,
  location, appearance, orientation, biometrics, open/close app, foreground
  app, home, back, alerts, keyboard, clipboard. Import `test` from the
  package to have it typed.
- `@e2edev/agent-device/tools` exports `agentDeviceTools(...backends)`: an
  `open_app`, `swipe`, `type_text`, `alert`, and `screenshot` pack for
  `createAgent`, scoped to the platforms of the backends passed and
  dispatching to the one whose attempt is running, so one pack serves an iOS
  and an Android target in the same config.
