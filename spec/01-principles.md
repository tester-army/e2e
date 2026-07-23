# 01 — Design Principles

## Why

There is no cross-platform testing framework built on agentic testing.
Playwright owns web; Detox/Maestro fragment mobile; the AI testing tools are
web-only libraries bolted onto other runners. `e2e` is a new category: one
framework where a test is a *user workflow* — executed by an agent, pinned
down deterministically where you choose — running unchanged on web, iOS,
and Android.

The ambition: one API spanning what Playwright (web) and Maestro (mobile)
each cover — full deterministic parity for migrators (see 12-migration.md),
agentic testing as the reason to switch. Starting from scratch is the
advantage: take the best of both without inheriting either's constraints.

> **The last testing framework you will ever need.**

## Mental model

> Playwright ergonomics + Vercel AI SDK simplicity + managed resources.

`e2e` is not a DSL and not a no-code tool. It is a tiny TypeScript-native
framework where the AI agent is a fixture, not the whole product.

## Principles

### 1. Smallest useful primitive wins

The first example a user sees must be ≤ 10 lines and use exactly three
concepts: `test()`, `agent.act()`, `agent.assert()`. Everything else is
progressive disclosure.

### 2. One obvious import

```ts
import { test, expect } from 'e2e';
```

All day-one usage comes from the root export. Advanced surfaces live behind
subpath exports (`e2e/cloud`) so the root stays
small and greppable.

### 3. Options objects everywhere

No API takes more than one required positional argument. Everything else is a
trailing options object. This keeps signatures evolvable without breaking
changes.

```ts
await agent.act('invite a teammate as viewer', { email: 'ada@example.test' });
await agent.waitFor('the invite list has loaded', { timeout: 30_000 });
```

### 4. A control gradient, not a mode switch

Every step chooses how much model to use — three tiers on one gradient:

1. `agent.act('goal')` — the agent plans a flow
2. `agent.tap('the login button')` — AI locates once (cached), action is deterministic
3. `screen.getByRole('button', { name: 'Login' }).tap()` — zero AI

All three are cross-platform, and tier 3 is a headline, not a fallback:
`screen` + `web` + `app` + `device` form a deterministic surface with
Playwright/Maestro parity (12-migration.md). `screen` is a **projection
layer, not an automation engine**: queries delegate to the target's backend
automation (browser locators on web, accessibility queries on mobile) —
waiting and actionability are the backend's, and which backend is an
internal driver detail, never exposed in the API. Web-only capabilities
(css, network interception, dialogs) live on `web`; mobile system utils on
`device`.

### 5. Provider abstraction, not provider lock-in

Runners, browsers, automation backends, and resources are values in config,
not code changes:

```ts
runner: 'local' | 'cloud'
browser: 'chromium' | 'firefox' | 'webkit'
driver: 'playwright' | agentBrowser() | anyCommunityDriver()
resources: { email: 'local' | 'managed' }
```

The same test file runs locally, in CI, and in TesterArmy Cloud unchanged.
Automation backends are **separate packages** built on a public driver SPI
(`e2e/driver`) — the community can ship backends we never thought of, and
if a 100× faster browser engine appears, adopting it is one install and one
config line (see 09-drivers.md).

### 6. Resources, not plumbing

Test-world primitives are declared as resources with clean handles. v0
ships `credentials`; email inboxes, webhook captures, files, and phone
numbers follow as extensions on the same model — users will never poll
IMAP or wire OTP plumbing by hand.

### 7. Local-first, cloud-better

Everything in the OSS package works fully offline/CI with no account.
TesterArmy Cloud is a one-line config change (`runner: 'cloud'`) that swaps in
managed backends for the exact same API. No cloud-only syntax.

### 8. Deterministic and agentic — both, interleaved

Mixing tiers within one test is the expected style, not a smell.
Determinism comes from two places:

1. **`screen`** — deterministic cross-platform queries, zero model calls.
2. **Agent caching** — instant-action locations cache as `screen`-shaped
   queries; `act()` paths cache as reviewable traces. Agentic once,
   near-deterministic after.

World-state assertions (resource matchers, e.g. a future
`expect(inbox).toHaveEmail(…)`) are always deterministic. See
10-determinism.md.

### 9. Cross-platform by design

A test describes a user workflow; a **target** decides where it runs. Both
the agentic API (`agent.*`, `app.*`, resources) and the
deterministic one (`screen.getByRole(…).tap()`, Testing Library-style) are
platform-agnostic — the React Native principle: one set of primitives, each
platform implements them natively. Only `device` (mobile system utils) and
platform-specific flows constrain a test to a platform. And the platform
set itself is **open**: web/iOS/Android are official, but a driver package
can introduce Electron, desktop, or TV without a core release. See
08-platforms.md and 09-drivers.md.

Testing Library's guiding principle carries over: *the more your tests
resemble the way your software is used, the more confidence they give you.*
The agent is that user — it perceives the app through the accessibility
tree and screenshots, exactly like assistive tech and human eyes do.

### 10. Human-readable failure output

Failures should read like a QA report: what the agent tried, what it saw,
screenshots/trace/video attached. Never a bare selector timeout.

### 11. Boring config

`e2e.config.ts` with `defineConfig()`. Sensible defaults so a config file is
optional for the happy path.

## Non-goals

- No YAML/JSON test DSL.
- No recorder-first workflow (may come later, never primary).
- No homegrown automation engine — `screen` is a thin projection onto each
  platform's backend; waiting and actionability are theirs. Backends are an
  internal driver detail: no backend object appears in the public API (an
  escape hatch to unpack it may come later, deliberately not in v0).
- No unit-testing ambitions. This is workflows/E2E only.
- v0 runs web targets only; iOS/Android land in v1. But the API is
  cross-platform from day one — portable tests written today run on mobile
  without edits (see 08-platforms.md).
- v0 does not ship phone/SMS resources (Cloud roadmap).

## Naming rules

- The word is **services** / **resources** / **sandbox** — never "mock".
- Agent verbs are plain English: `agent.act()`, `agent.login()`,
  `agent.assert()`.
- Test files end in `.e2e.ts`.
- **Boring names on purpose.** The deterministic surface deliberately
  mirrors Playwright and Testing Library vocabulary (`getByRole`, `fill`,
  `toBeVisible`, …). Humans migrate by muscle memory — and models trained
  on those ecosystems emit near-valid e2e code without knowing e2e exists.
  Familiarity is also AI-legibility (see 12-migration.md).
