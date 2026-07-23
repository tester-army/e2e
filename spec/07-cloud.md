# 07 — OSS / Cloud Boundary

The OSS package must be fully useful standalone. Cloud is the same API with
better backends — never different syntax.

The dependency direction is fixed: **Cloud is built on the SDK**, not the
other way around. The SDK is the canonical model of what a test is; Cloud
executes SDK tests and renders their step timeline. There is no parallel
hosted test format to stay compatible with — this spec is a greenfield
design. Learnings from running the current TesterArmy platform (host-side
secret filling, path caching, budgets, typed error codes) inform the
execution model, but no existing schema, API, or storage format constrains
these primitives. Cloud will be rebuilt on top of them.

## Rule

> If it appears in a test file, it works locally.
> Cloud only changes *how well* it works.

## Matrix

| Capability | OSS (local) | TesterArmy Cloud |
|---|---|---|
| `test()`, `agent.act()`, `agent.assert()` | ✅ bring-your-own model key | ✅ managed models, tuned agent |
| Browsers | local browsers | managed browser fleet, more OS/devices |
| Mobile targets (iOS/Android) | local simulators/emulators (v1) | managed real-device fleet, OS/device matrix |
| `credentials.user()` | env / config | team vault, rotation, audit |
| Agent path cache | local `.e2e/cache` | shared across team + CI, flake-aware invalidation |
| Sessions (`test.setup`) | `.e2e/sessions` on disk | per-run, shared across workers, encrypted |
| Artifacts | trace/screenshot/video + HTML report on disk | hosted replays, retention, sharing |
| Scheduling/monitors | ❌ | ✅ cron runs, alerting |
| Flake triage | retries | historical flake detection, quarantine |

Resource extensions (email inboxes first, then webhook captures, files,
phone/SMS) follow the same local/managed split when they land — see
roadmap/.

## Switching

Exactly one of:

```ts
// config
export default defineConfig({ runner: 'cloud', token: process.env.TESTERARMY_TOKEN });
```

```bash
# CLI
npx e2e run --cloud
```

No test-file changes, ever. This is a hard API guarantee.

## `e2e/cloud` subpath

Advanced, optional programmatic access (dashboards, custom tooling):

```ts
import { cloud } from 'e2e/cloud';

const run = await cloud.runs.get(id);
const runs = await cloud.runs.list({ project: 'my-project' });
```

```ts
type CloudRun = {
  id: string;
  project: string;
  status: 'queued' | 'running' | 'passed' | 'failed';
  url: string;            // hosted replay
  startedAt: Date;
  finishedAt?: Date;
};
```

Kept out of the root export deliberately — day-one users never see it.

## v0 ship list (OSS)

The deliberately small core. Everything here must be excellent; everything
else waits.

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
- `defineConfig()` (+ `e2e.cloud.config.ts` overlay)
- CLI: `init`, `run`
- GitHub Actions examples

Explicitly **not** in v0 (see spec/roadmap/): iOS/Android execution (v1),
email/webhook/files/phone resources, `test.each`/`skipIf`/`failsIf`/
`fixme`/`test.extend`, `globalSetup`/`globalTeardown`, sharding, watch
mode (`e2e dev`), inspector (`e2e open`), credentials store CLI, soft
assertions, PR testing, service emulation, scheduling.

## Positioning line

> `e2e` is the open-source, cross-platform, agentic testing framework —
> one test runs on web, iOS, and Android. The last testing framework you
> will ever need. Use TesterArmy Cloud for managed browsers and devices,
> test identities, email/phone resources, and replays.
