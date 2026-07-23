# 07 — v0 Scope

The deliberately small core. Everything here must be excellent; everything
else waits. v0 is **local-first and standalone**: it runs offline and in
CI with no account and no hosted service — the goal is the best agentic
testing framework, nothing else.

## Rule

> If it appears in a test file, it works locally, today.
> Anything that can't is roadmap — reserved, not shipped.

## v0 ship list

Runner:
- `test()`, `skip`/`only`, hooks, `describe` (+ options, serial)
- `test.setup()` + sessions
- Derived step timeline (no `step()` wrapper — steps come from the calls)

Agent:
- `agent.act()` (+ typed `schema` output), `agent.assert()`,
  `agent.login()`, `agent.extract()`
- Instant actions (`agent.tap/click/type/scroll/scrollTo/longPress/waitFor`)
- Locate + path caching, typed `AgentError.code`

Deterministic layer:
- `screen` queries + `expect(locator)` matchers (web projection in v0)
- `web` surface + `expect(web)` matchers
- Cross-platform type surface (`app`, `screen`, `platform`, `targets`,
  `platforms`) — web execution only in v0
- Driver SPI (`e2e/driver`): `defineDriver`, `verifyDriver` conformance
  suite, `e2e/playwright` as the reference driver

Resources:
- `credentials.user()` (env/config) — the resource model; extensions
  (email first) come post-v0

Tooling:
- `defineConfig()`
- CLI: `init`, `run`
- GitHub Actions examples

## Explicitly not in v0

See [roadmap/](./roadmap/README.md) for the parked designs:

- iOS/Android execution (v1)
- TesterArmy Cloud — hosted runner, managed backends, `runner`/`--cloud`/
  `e2e login` ([roadmap/cloud.md](./roadmap/cloud.md))
- email/webhook/files/phone resources
- `test.each` / `skipIf` / `failsIf` / `fixme` / `test.extend`
- `globalSetup` / `globalTeardown`, sharding
- watch mode (`e2e dev`), inspector (`e2e open`), credentials store CLI
- soft assertions, PR testing, service emulation, scheduling
