# Roadmap

Deferred designs. Not part of the v0 spec — the core must ship and win
first. Designs here are drafts kept for when their time
comes; they will be re-validated against the then-current core API before
adoption.

## Larger designs

| Item | Design | Summary |
|---|---|---|
| TesterArmy Cloud | [cloud.md](./cloud.md) | Hosted runner + managed backends (browsers, devices, resources, replays, shared caches) behind the same API — one config switch, zero test-file changes; `runner`/`token`/`--cloud`/`e2e login` reserved |
| Service emulation | [service-emulation.md](./service-emulation.md) | Local, stateful Stripe/Slack/email emulators as a `services` fixture with first-class assertions (`expect(stripe).toHavePayment(…)`); managed sandboxes in Cloud |
| PR testing | [pr-testing.md](./pr-testing.md) | `pr.context()`, preview-URL resolution, changed-file test selection, exploratory `test.dynamic`, automatic GitHub Checks |
| Visual snapshots | — | `toMatchScreenshot` pixel diffing, complementing `agent.assert` semantic judgment |
| Network interception | — | cross-platform request routing, if it earns its place over service emulation |
| New platforms (Electron, desktop, TV) | enabled by design ([08](../08-platforms.md)/[09](../09-drivers.md)) | arrive as driver packages on the open platform model — no core changes; "official" status = docs + conformance in CI |
| Driver-provided fixtures | mechanism specced ([02](../02-test-api.md)/[09](../09-drivers.md)): module augmentation on `TestFixtures` | the first non-browser/mobile family surface ships with its platform driver; the generic SPI slot is finalized then |

## Deferred from the v0 core

Designed, cut for focus. API sketches live in git history; each returns as a
deliberate addition, not a drive-by.

| Item | Shape |
|---|---|
| Email inboxes | the first resource extension: `email.inbox()` → unique `address`, `.code()`/`.link()` OTP extraction, `expect(inbox).toHaveEmail(…)`; local SMTP catcher or managed deliverable inboxes |
| Webhook captures | `webhook.capture()` → `hook.url` / `waitFor()`; `expect(hook).toHaveReceived({ body })` |
| File fixtures | `files.from(path, { context })`, act `files` param, `files.index()` |
| Phone/SMS resources | `phone.number()` with SMS/OTP extraction — Cloud-first |
| Parameterization | `test.each(cases)('title $key', options?, fn)` |
| Conditional skips | `test.skipIf` / `test.failsIf` / `test.fixme` |
| Custom fixtures | `test.extend()` — lazy setup/teardown; home of per-test tenants/DB seeding |
| Global run hooks | `globalSetup` / `globalTeardown` in config |
| Sharding | `--shard n/total`, deterministic assignment |
| Watch mode | `e2e dev` — headed, sessions alive, warm cache, re-run on change. **First fast-follow candidate**: the Vitest lesson is that the inner loop drives retention (PLAN.md) |
| Migration codemod | `e2e migrate` — mechanical Playwright-spec conversion per the 12-migration tables |
| Inspector UI | `e2e open` — step timeline, screenshots, traces, resource events |
| Soft assertions | `expect.soft(…)`, `agent.assert('…', { soft: true })` |
| Custom matchers | `expect.extend()` — free for value matchers via the engine; async locator/resource matchers need the retry-wrapper API |
| Step grouping marker | closure-less `step('reach checkout')` section markers for timeline organization — only if dogfood shows noise; steps themselves are always derived from calls |
| Credentials store | `e2e credentials set/list/rm` (encrypted local store) + `Credential.reveal()` |
| Cloud CLI auth | `e2e login` / `e2e logout` (device flow) |
| Temporary-email login | `agent.login({ temporaryEmail: true })` |
| GitHub reporter | `--reporter github` workflow annotations |
| HAR artifacts | `artifacts: ['har']`, record/replay |

(The driver SPI is **not** roadmap — it's core, see
[09-drivers.md](../09-drivers.md): community backends are a founding goal.)

## Why deferred

The core bet is narrow and deep: **cross-platform agentic testing** —
`test()`, the agent tiers, `screen`, resources, sessions, targets. Nothing
above is required to prove that bet; everything above gets stronger once the
core is adopted.
