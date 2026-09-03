---
'@e2edev/e2e': patch
---

CLI, config, and report correctness:

- Usage errors (unknown flag or command, malformed value) exit 2 as the spec
  reserves for CLI errors; `--help` and `--version` exit 0. Previously commander
  exited 1, which CI reads as a test failure.
- `--workers` and `--retries` obey the same bounds as the config keys they
  replace; `--workers 0` no longer plans work no worker can take.
- A live `agent.visionModel` instance is reduced to its identity before the
  config digest, like `agent.model`, so provider settings never enter the
  digest and workers agree on it.
- A non-array `targets` is an `INVALID_CONFIG` error instead of a crash.
- `run.status` can be `blocked` when the only failures are serial-group
  members blocked by the agent's budget or environment.
- `defineBackend` binds fixture factories like every other member, so a
  class-based backend keeps `this` in its fixtures.
- Test files and the config are loaded through one registered TypeScript
  loader instead of registering a new loader hook per import; large suites no
  longer slow down as they collect.
- The list reporter's live block stops repainting once the run has ended.
