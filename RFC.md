# RFC0000: e2e — one agentic testing framework for web, iOS, and Android

## Summary

`e2e` is an open-source, cross-platform, agentic testing framework. A test
describes a **user workflow**; an agent executes it; a **target** decides
where it runs — web, iOS, or Android, unchanged. One API covers what today
takes Playwright (web) plus Maestro (mobile): full deterministic parity
for migrators, agentic testing as the reason to switch. Local-first OSS:
no account, no hosted service — managed backends are a roadmap design
behind the same API.

> The last testing framework you will ever need.

## Basic example

All three tiers of the control gradient, one resource, both assertion
styles — in one test:

```ts
import { test, expect, credentials } from 'e2e';

export default test('member upgrades to the Pro plan', async ({ app, agent, screen }) => {
  await app.open('/settings/billing');

  await agent.login(credentials.user('member'));                // resource: secret never enters the model

  await screen.getByRole('button', { name: 'Upgrade' }).tap();  // deterministic — zero AI
  await agent.tap('the Pro plan card');                         // AI locates once, cached
  await agent.act('complete payment with the test card');       // agent plans the flow

  await agent.assert('the billing page shows Pro as active');
  await expect(screen.getByRole('status')).toContainText('Pro');
});
```

```bash
pnpm add e2e && npx e2e run        # zero config with APP_URL set
```

## Motivation

Five constraints no existing tool solves together:

1. **E2E cost is authoring + maintenance.** Selector-first tests are slow
   to write and break when the UI churns. The industry answer is "hire
   patience"; ours is an agent that plans flows and locates elements.
2. **The world around the app is the hard part.** Email OTPs, test
   accounts, webhooks — teams hand-roll IMAP polling and secret plumbing.
   These must be first-class resources, not glue code.
3. **One product, two test stacks.** Teams ship web + mobile and write
   every flow twice (Playwright and Maestro/Detox), in different languages
   with different ceilings.
4. **Naive AI testing doesn't survive CI.** Pure-agent tools are slow,
   expensive, and nondeterministic. Determinism must be available *per
   step* and emerge automatically through caching — not be a mode switch.
5. **Agents are becoming the authors.** Coding agents scaffold projects
   and write tests; the default framework of the next decade is the one
   agents pick. That demands machine-legible APIs, reports, and failures.

Playwright owns web, superbly — and is web-only by design. Detox/Maestro
fragment mobile. AI testing tools are web-only libraries bolted onto other
runners. The category — cross-platform agentic testing — is
empty. Expected outcome: `e2e` becomes the default for new projects, the
way Vitest became the default over Jest.

## Detailed design

The full spec lives in [spec/](./spec); normative surface is the TS blocks
in those docs. The essentials:

**A control gradient, not a mode switch** ([10](./spec/10-determinism.md)).
Three tiers interleave freely in one test; choosing per step is the core
authoring decision:

| Tier | Example | Model's role |
|---|---|---|
| Planning | `agent.act('buy the pro plan')` | plans + executes a flow |
| Instant | `agent.tap('the login button')` | locate only; action deterministic, location cached |
| `screen` | `screen.getByRole('button', { name: 'Buy' }).tap()` | none — zero AI |

**Deterministic surface with Playwright ∩ Maestro parity**
([08](./spec/08-platforms.md), [12](./spec/12-migration.md)). `screen` is
Testing Library projected onto each platform's accessibility layer (ARIA /
iOS traits / AccessibilityNodeInfo) — a projection, not an automation
engine: waiting and actionability belong to the backend. `web` carries
web-only powers (network interception, cookies, dialogs); `app`/`device`
carry Maestro's lifecycle and system utils. Every migration-table row is
mapped, planned, or rejected with a reason.

**Execution model: code drives, agents are bounded**
([10](./spec/10-determinism.md)). No outer agentic loop. Each `agent.*`
call is an isolated sub-agent with a step budget; continuity flows through
a compact **ledger** (handoff summaries), values flow through code.
Transcripts are discarded; context cost stays flat. Secrets are filled
host-side by reference and never enter model context. Failures carry typed
codes (`AgentError.code`) separating setup, runtime, and product failures.

**Agentic once, near-deterministic after.** Instant-action locations cache
as human-readable `screen` queries (committable, reviewed in PRs, AI
fallback on mismatch); `act()` paths replay as guidance with
re-observation. Repeat runs of unchanged UI approach zero model calls.

**Resources** ([04](./spec/04-resources.md)). v0 ships the model plus one
resource: `credentials.user()` (write-only handles, env/config
resolution). Email inboxes (`.code()`/`.link()` OTP extraction,
`toHaveEmail`), webhook captures, files, and phone numbers follow as
**extensions** on the same model — identical test code whatever backend
serves the resource.

**Open platforms via a driver SPI** ([09](./spec/09-drivers.md)). Drivers
are npm packages implementing a small contract (query projection,
observation, actions, artifacts). Playwright is just the default web
driver. A driver declaring `platforms: ['electron']` makes Electron a
first-class target — the platform set is open; the portable API is the
contract, enforced by a `verifyDriver` conformance suite.

**Runner and CLI** ([06](./spec/06-cli.md)). TS/ESM native, no transform
config. `npx e2e init && npx e2e run` to first green in minutes; browsers
auto-provision. Deterministic-only suites need no API key. Reports are a
derived step timeline — every call is a self-labeled step; no `step()`
ceremony. Exit codes separate test failures from config and infra errors.

**Local-first, standalone** ([07](./spec/07-scope.md)). If it appears in a
test file, it works locally, today — no account, no hosted service.
Managed backends (browsers, devices, resources, shared caches, hosted
replays) are a reserved roadmap design behind the exact same API
([roadmap/cloud.md](./spec/roadmap/cloud.md)) — if they land, it's a
config value, never new syntax.

## Drawbacks

- **Implementation cost is real.** A runner, an agent orchestrator, and a
  parity surface. Mitigated by absorbing Playwright as the default driver
  (its auto-waiting is ours) and by the migration table acting as a scope
  contract — parity is finite and enumerated.
- **Could be user space?** The agentic layer alone could be a library on
  Playwright (that's what existing AI tools are). But cross-platform
  targets, the locate/path cache, resources, budgets, and the ledger all
  live in the runner — a library can't own the loop, the report, or
  non-web platforms.
- **Model dependency.** Agent tiers need a model key, cost money, and add
  latency. Mitigations: the zero-AI tier is complete (keyless suites are
  first-class), caching converges hot paths to deterministic replay, and
  budgets/typed errors keep CI failures diagnosable.
- **Teaching burden.** Three tiers means judgment ("which tier here?").
  The rule of thumb is teachable in one line (see below), but it is a new
  mental model on top of familiar names.
- **Standing next to a beloved incumbent.** Playwright has ~91%
  satisfaction and momentum. We don't try to out-automate it — we build on
  it and focus on a layer it doesn't aim at (agent-native execution,
  cross-platform, resources). If that layer turns out not to matter, e2e
  is just a nicer wrapper. That's the bet.
- **Parity maintenance.** Playwright and Maestro keep evolving; the
  migration tables are a standing liability that must be curated.

## Alternatives

- **A library on top of Playwright** (Stagehand-style): cheapest, but
  web-only forever, no unified runner/report, caching bolted on, resources
  out of scope. Rejected: the category needs a framework, not a helper.
- **Fork Playwright**: inherits a web-only scope and a huge surface we'd
  have to maintain. Rejected: the driver SPI gives us its strengths as-is.
- **YAML/no-code DSL** (Maestro's path): approachable, then a ceiling.
  Rejected as a non-goal — plain TypeScript with `if`/`for` beats every
  DSL conditional.
- **Pure agent, no determinism** (computer-use loops): unreviewable,
  expensive, flaky in CI. Rejected: determinism-by-caching and the
  `screen` tier are the point.
- **Host inside an existing runner** (Vitest/Jest project): unit runners
  don't model targets, sessions, per-target artifacts, or device
  lifecycles. Rejected, while stealing Vitest's DX bar wholesale.

## Adoption strategy

The Vitest playbook ([PLAN.md](./PLAN.md)):

1. **Coexist, never rewrite.** e2e runs alongside an existing Playwright
   suite (it *is* Playwright underneath). New tests first; port on touch;
   sunset the old suite when it stops earning its CI minutes. Migrating
   means deleting config, not porting it.
2. **Mechanical migration.** The [12-migration](./spec/12-migration.md)
   tables are the contract; an `e2e migrate` codemod is roadmap. Not a
   breaking change for anyone — greenfield-first by design.
3. **Agents are the distribution channel.** `e2e init` writes agent
   guidance (AGENTS.md), docs ship llms.txt, reports have a stable JSON
   schema, and the API mirrors Playwright/Testing Library vocabulary so
   models emit near-valid e2e code from existing training data.
4. **Own the name.** The npm package `e2e` is ours — `import { test } from
   'e2e'` is what an agent would guess.

## How we teach this

- **One sentence for the gradient:** *`act()` when you know the goal,
  instant actions when you know the steps, `screen` when you know the
  elements.* Mixing tiers is the expected style, not a smell.
- **Familiar words, deliberately.** `getByRole`, `fill`, `toBeVisible`,
  targets-as-projects, `beforeEach` — Playwright and Testing Library
  muscle memory carries over; only the agent tiers are new. Terminology
  discipline: **resources**, never "mocks"; tests are **user workflows**.
- **First example ≤ 10 lines, three concepts** (`test`, `agent.act`,
  `agent.assert`); everything else is progressive disclosure.
- **Failures teach.** Output reads like a QA report — what the agent
  tried, what it saw, screenshot attached — never a bare selector timeout.
- Docs restructure: quickstart (agentic) → control gradient → resources →
  migration tables for Playwright/Maestro veterans.

## Unresolved questions

- `app.open(path)` on mobile: path → deep-link mapping (per-target
  `deepLinkBase`?) — the flagship portability example depends on it.
- Model configuration: provider/key env vars, local models, and the exact
  keyless failure contract.
- Sync resource handles (a future `inbox.address`) vs managed backends:
  catch-all domains + prefetch, or async factories — decide before the
  first extension lands.
- Locate-cache keying: target description alone collides across screens —
  include test/step identity or a screen fingerprint.
- Safety: prompt-injection hardening, origin confinement, and
  production-URL guardrails need a spec section.
- License (MIT vs Apache-2.0) and governance for community drivers.
- Timing of `e2e dev` (watch mode): the Vitest lesson says the inner loop
  drives retention; currently a Phase 3 candidate.
