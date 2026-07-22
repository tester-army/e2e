# 09 — Drivers (Automation Backends)

Tests are written against e2e-owned surfaces (`agent`, `screen`, `app`,
`device`); **drivers** implement them per target. Backends are switchable
without touching test code — same philosophy as `runner: 'local' | 'cloud'`
and `resources.email: 'local' | 'managed'`. Nothing driver-specific is
reachable from a test: backends are a fully internal implementation detail.

## Why

- No lock-in to Playwright (or anything else). The web ecosystem is moving
  (agent-first browsers, CDP-native tools); mobile has no single winner. If
  a 100× faster browser backend ships tomorrow, adopting it must be one
  `npm install` and one config line — zero test changes.
- The community must be able to build backends we never thought of — the
  driver SPI is a public contract, not an internal detail.
- Cloud can run a different backend than local without test changes.
- The agent needs a uniform observation/action layer anyway — drivers are
  that layer.

## Drivers are packages

A driver exports a factory built with `defineDriver()` from `e2e/driver`.
Official drivers live under the `e2e` package's own namespace as **subpath
exports** (the `@e2e/*` npm scope is not available — and subpaths are
better anyway: one memorable namespace, consistent with `e2e/driver` and
`e2e/cloud`). Community drivers are their own npm packages:

| Import | Platform | Notes |
|---|---|---|
| `e2e/playwright` | web | default for web targets |
| `e2e/agent-browser` | web | agent-optimized browser backend |
| `e2e/agent-device` | ios, android | default for mobile targets |
| `e2e/appium` | ios, android | compatibility option |
| `e2e-driver-*` (npm) | any | community convention |

Names are illustrative until v1; the guarantees are the *shape* (driver =
a `defineDriver` factory) and the SPI contract.

Weight discipline: official driver subpaths declare their backends as
**optional peer dependencies** — installing `e2e` pulls in only the default
drivers' backends; importing `e2e/appium` without `appium` installed fails
with a clear "install appium" error. Internally, official drivers may be
separate workspace packages re-exported through subpaths — that's an
implementation detail, not API.

## Selection

Two forms — a string id for bundled defaults, or an imported instance
(the Vite-plugin pattern) for everything else:

```ts
// e2e.config.ts
import { defineConfig } from 'e2e';
import { agentBrowser } from 'e2e/agent-browser';
import { hyperdrive } from 'e2e-driver-hyperdrive'; // community: the 100x one

export default defineConfig({
  targets: [
    { name: 'web', platform: 'web', url: process.env.APP_URL },            // default: 'playwright'
    { name: 'web-agentic', platform: 'web', driver: agentBrowser(), url: process.env.APP_URL },
    { name: 'web-fast', platform: 'web', driver: hyperdrive(), url: process.env.APP_URL },
    { name: 'ios', platform: 'ios', app: 'build/MyApp.app' },              // default: 'agent-device'
  ],
});
```

```ts
driver?: string | Driver;   // string ids resolve to bundled drivers only
```

`driver` is optional — every platform has a bundled default. Most users
never set it.

## The contract

Drivers implement four capabilities. Note the deliberate boundary: `screen`
is a **query projection**, not an automation engine — waiting and
actionability belong to the backend:

1. **Query projection (`screen`)** — map the e2e query vocabulary
   (role/label/placeholder/text/displayValue/testId + state options) onto
   the backend's own locators (browser locators on web, accessibility
   queries on mobile). The backend's auto-waiting and actionability checks
   are used as-is.
2. **Observation** — what the agent sees: screenshot + semantic tree
   (DOM/AXTree on web, native accessibility tree on mobile). This is why
   `agent.act()` / `agent.assert()` work identically on every backend.
3. **Action execution** — the primitive actions the agent performs
   (tap/type/scroll by node reference or coordinate), plus the `app` handle
   and `device` system utils on mobile.
4. **Artifacts** — screenshots, video, traces (driver-dependent fidelity).

The backend object itself (e.g. a Playwright `Page` inside `e2e/playwright`)
is **never exposed to tests**. An unpack escape hatch was considered and
deliberately deferred — it would freeze backend choices into the public
contract.

## Driver SPI — `e2e/driver`

Public contract, versioned independently of the test-facing API
(`spiVersion`), so driver packages can declare compatibility:

```ts
import { defineDriver } from 'e2e/driver';

export function hyperdrive(options?: HyperdriveOptions) {
  return defineDriver({
    id: 'hyperdrive',
    platforms: ['web'],
    spiVersion: 1,

    async launch(ctx) {
      // boot the backend for ctx.target; return a session
      return {
        app: { /* open/restart/deepLink/screenshot */ },
        screen: { /* resolve e2e queries → node refs; perform locator actions */ },
        observe: {
          async screenshot() { /* … */ },
          async semanticTree() { /* SemanticNode tree with stable refs */ },
        },
        act: { /* tap/type/scroll/press by node ref or coordinate */ },
        async close() { /* … */ },
      };
    },
  });
}
```

The normative SPI types (`Driver`, `DriverSession`, `SemanticNode`, …) live
in `api.d.ts` under the `e2e/driver` section. Design rules:

- **Small on purpose.** A driver maps queries, observes, acts, and produces
  artifacts. Caching, budgets, the ledger, reporting, retries — all
  runner-side, identical across drivers. A driver author writes the mapping,
  not a framework.
- **`SemanticNode.ref` is the currency**: queries resolve to refs, the agent
  targets refs, the locate cache stores query→ref recipes. Stable refs
  within a screen are the driver's one hard problem.
- **Conformance suite**: `e2e/driver` ships a reusable test suite
  (`verifyDriver(myDriver)`) that community drivers run in their own CI —
  the ecosystem's compatibility guarantee.

## Consequences elsewhere in the spec

- `expect(locator)` matchers exist and are cross-platform (03) — they
  project onto the backend's assertion mechanics the same way queries do.
- No browser/context/page object appears anywhere in the public API — the
  framework is not committed to Playwright (or any backend) long-term.
- The instant-action locate cache stores `screen`-shaped queries (10),
  which drivers replay through the same projection — one resolution path
  for cached agent actions and hand-written deterministic steps.
