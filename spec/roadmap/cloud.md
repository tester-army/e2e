# Roadmap — TesterArmy Cloud

> **Status: roadmap.** Not part of the v0 framework. v0 is local-first and
> fully useful standalone — no account, nothing to sell. This design is
> preserved so the core keeps the door open; it will be re-validated
> against the then-current API before it lands (PLAN.md Phase 4).

Cloud is the same API with better backends — never different syntax.

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
| 2FA / bot detection (your own app) | test bypasses, allowlisting | real OTP via managed inboxes/numbers, host-side TOTP, stable allowlistable egress, real-device traffic |
| Scheduling/monitors | ❌ | ✅ cron runs, alerting |
| Flake triage | retries | historical flake detection, quarantine |

Resource extensions (email inboxes first, then webhook captures, files,
phone/SMS) follow the same local/managed split when they land.

## Switching (reserved shape)

Exactly one of:

```ts
// config
export default defineConfig({ runner: 'cloud', token: process.env.TESTERARMY_TOKEN });
```

```bash
# CLI
npx e2e run --cloud
```

No test-file changes, ever. This is a hard API guarantee. The `runner`,
`project`, and `token` config fields, the `e2e.cloud.config.ts` overlay,
`--cloud`, `e2e login`, and `TESTERARMY_TOKEN` are all reserved for this
design — none ship in v0.

## `e2e/cloud` subpath (reserved)

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
