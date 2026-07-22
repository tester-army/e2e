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
| `email.inbox()` | local SMTP catcher / adapters | real deliverable managed inboxes |
| `credentials.user()` | env / encrypted local store | team vault, rotation, audit |
| `webhook.capture()` | localhost URL | public URLs |
| `phone.number()` | ❌ (roadmap) | ✅ real numbers, SMS/WhatsApp |
| Agent path cache | local `.e2e/cache` | shared across team + CI, flake-aware invalidation |
| Sessions (`test.setup`) | `.e2e/sessions` on disk | per-run, shared across workers, encrypted |
| Artifacts | trace/screenshot/video on disk | hosted replays, retention, sharing |
| `e2e open` | local inspector | hosted timeline w/ service events |
| Scheduling/monitors | ❌ | ✅ cron runs, alerting |
| Flake triage | retries | historical flake detection, quarantine |

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

Kept out of the root export deliberately — day-one users never see it.

## v0 ship list (OSS)

Runner:
- `test()`, modifiers, hooks, `describe` (+ options, serial), `step()`
- `test.setup()` + sessions, `test.each`, `skipIf`/`failsIf`,
  `globalSetup`/`globalTeardown`, `--shard`

Agent:
- `agent.act()`, `agent.assert()`, `agent.login()`, `agent.extract()`
- Instant actions (`agent.tap/type/scroll/longPress/waitFor`)
- Locate + path caching, typed `AgentError.code`

Deterministic layer:
- `screen` queries + `expect(locator)` matchers (web projection in v0)
- Cross-platform type surface (`app`, `screen`, `platform`, `targets`,
  `platforms`) — web execution only in v0
- Driver SPI (`e2e/driver`): `defineDriver`, `verifyDriver` conformance
  suite, `e2e/playwright` as the reference driver

Resources:
- `email.inbox().code()/.link()`, `credentials.user()`, `webhook.capture()`, `files.from()`
- `expect()` resource matchers

Tooling:
- `defineConfig()`
- CLI: `init`, `run`, `dev`, `open`, `credentials`
- GitHub Actions examples

Explicitly **not** in v0: iOS/Android execution (v1), PR testing, service
emulation (Stripe/Slack/OAuth), phone/SMS, scheduling. See spec/roadmap/.

## Positioning line

> `e2e` is the open-source, cross-platform, agentic testing framework —
> one test runs on web, iOS, and Android. The last testing framework you
> will ever need. Use TesterArmy Cloud for managed browsers and devices,
> test identities, email/phone resources, and replays.
