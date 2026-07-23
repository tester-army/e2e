# 09 — Drivers (Automation Backends)

Tests are written against e2e-owned surfaces (`agent`, `screen`, `app`,
`device`); **drivers** implement them per target. Backends are switchable
without touching test code — the same provider-abstraction philosophy as
resource backends. Nothing driver-specific is reachable from a test:
backends are a fully internal implementation detail.

## Why

- No lock-in to Playwright (or anything else). The web ecosystem is moving
  (agent-first browsers, CDP-native tools); mobile has no single winner. If
  a 100× faster browser backend ships tomorrow, adopting it must be one
  `npm install` and one config line — zero test changes.
- The community must be able to build backends we never thought of — the
  driver SPI is a public contract, not an internal detail.
- Hosted runners (roadmap/cloud.md) can run a different backend than local
  without test changes.
- The agent needs a uniform observation/action layer anyway — drivers are
  that layer.

## Drivers are packages

A driver exports a factory built with `defineDriver()` from `e2e/driver`.
Official drivers live under the `e2e` package's own namespace as **subpath
exports** (the `@e2e/*` npm scope is not available — and subpaths are
better anyway: one memorable namespace, consistent with `e2e/driver`).
Community drivers are their own npm packages:

| Import | Platform | Notes |
|---|---|---|
| `e2e/playwright` | web | default for web targets |
| `e2e/agent-browser` | web | agent-optimized browser backend |
| `e2e/agent-device` | ios, android | default for mobile targets |
| `e2e/appium` | ios, android | compatibility option |
| `e2e-driver-*` (npm) | any, **including new ones** | community convention |

Names are illustrative until v1; the guarantees are the *shape* (driver =
a `defineDriver` factory) and the SPI contract.

Drivers do more than swap backends: **they introduce platforms**. The
platform vocabulary is open (08-platforms.md) — a driver declaring
`platforms: ['electron']` makes `electron` a valid target platform, and
`agent`, `app`, `screen`, and `expect` work there unchanged because they
only ever speak the SPI. Electron, desktop, TV: none of them need a core
release.

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
import { electron } from 'e2e-driver-electron';     // community: a new platform

export default defineConfig({
  targets: [
    { name: 'web', platform: 'web', url: process.env.APP_URL },            // default: 'playwright'
    { name: 'web-agentic', platform: 'web', driver: agentBrowser(), url: process.env.APP_URL },
    { name: 'web-fast', platform: 'web', driver: hyperdrive(), url: process.env.APP_URL },
    { name: 'ios', platform: 'ios', app: 'build/MyApp.app' },              // default: 'agent-device'
    { name: 'desktop', driver: electron({ main: 'out/main.js' }) },        // platform: 'electron'
  ],
});
```

```ts
driver?: string | Driver;   // string ids resolve to bundled drivers only
```

`driver` is optional for official platforms — each has a bundled default,
and most users never set it. Target-level `platform` is inferred when a
driver instance supports exactly one platform; a driver spanning several
(like `agent-device`) needs the target to say which. Platform-specific
options for community platforms live on the driver factory (typed by its
package), not as loose target fields.

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
   (tap/type/scroll by node reference or coordinate), plus the `app` handle,
   the `web` surface on web, and `device` system utils on mobile.
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
        app: { /* open/restart/clearState/back/deepLink/screenshot */ },
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

The full SPI contract:

```ts
/** A node in the semantic tree. `ref` is stable within one screen state. */
type SemanticNode = {
  /** Opaque, driver-issued reference — the currency between queries, agent actions, and the locate cache. */
  ref: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  states?: Partial<Record<'checked' | 'disabled' | 'selected' | 'expanded' | 'focused' | 'hidden', boolean>>;
  /** Element attributes where the platform has them (web: DOM attributes). */
  attributes?: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
  children?: SemanticNode[];
};

/** e2e query, normalized — what the runner hands a driver to resolve. */
type ResolvedQuery = {
  kind: 'role' | 'label' | 'placeholder' | 'text' | 'displayValue' | 'testId';
  value: string | RegExp;
  options?: RoleOptions & TextMatchOptions;
  /** Scope chain (within): resolve relative to this node. */
  within?: string; // parent ref
};

/** Every Locator action, normalized — the driver maps each onto its backend. */
type LocatorAction =
  | { kind: 'tap' | 'doubleTap' | 'longPress' | 'check' | 'uncheck' | 'clear' | 'focus' | 'scrollIntoView' }
  | { kind: 'fill'; value: string }
  | { kind: 'press'; key: string }
  | { kind: 'selectOption'; value: string | { label?: string; index?: number } }
  | { kind: 'dragTo'; target: string /* ref */ }
  | { kind: 'swipe'; direction: ScrollDirection; momentum?: Momentum };

type DriverContext = {
  target: Target;
  artifactsDir: string;
};

type DriverSession = {
  /** Backs the `app` fixture — the full portable surface (08-platforms.md). */
  app: {
    open(path?: string): Promise<void>;
    restart(): Promise<void>;
    clearState(): Promise<void>;
    back(): Promise<void>;
    deepLink(url: string): Promise<void>;
    /** Returns artifact path. */
    screenshot(label?: string): Promise<string>;
  };

  /** Query projection backing `screen` — backend waiting/actionability used as-is. */
  screen: {
    /** Resolve a query to matching node refs (no waiting; the runner drives retry). */
    resolve(query: ResolvedQuery): Promise<string[]>;
    /** Perform a locator action on a resolved node, with backend actionability checks. */
    perform(ref: string, action: LocatorAction): Promise<void>;
    /** Read state for matchers and locator reads (visible/checked/text/value/attributes/rect). */
    read(ref: string): Promise<SemanticNode>;
  };

  /** Observation backing the agent — same contract on every backend. */
  observe: {
    screenshot(): Promise<string>;
    semanticTree(): Promise<SemanticNode>;
  };

  /** Primitive actions the agent performs (by node ref or coordinate). */
  act: {
    tap(target: { ref: string } | { x: number; y: number }): Promise<void>;
    type(target: { ref: string }, text: string): Promise<void>;
    scroll(direction: ScrollDirection, options?: { target?: { ref: string }; momentum?: Momentum }): Promise<void>;
    press(key: string): Promise<void>;
  };

  /**
   * Web-parity surface backing the `web` fixture (08-platforms.md) — web
   * drivers only. Reuses the public interface: one contract, no drift.
   */
  web?: Web;

  /** Mobile system utils backing `device` (08-platforms.md) — mobile drivers only. */
  device?: Device;

  /** Optional artifact recorders; fidelity is driver-dependent. */
  artifacts?: {
    startVideo?(): Promise<void>;
    stopVideo?(): Promise<string>;   // artifact path
    startTrace?(): Promise<void>;
    stopTrace?(): Promise<string>;   // artifact path
  };

  close(): Promise<void>;
};

type Driver = {
  readonly id: string;
  readonly platforms: Platform[];
  /** SPI compatibility version. Current: 1. */
  readonly spiVersion: 1;
  launch(ctx: DriverContext): Promise<DriverSession>;
};

/** Identity helper with type checking — how driver packages are built. */
function defineDriver(driver: Driver): Driver;

/** Reusable conformance suite; driver packages run it in their own CI. */
function verifyDriver(driver: Driver): void;
```

Design rules:

- **Small on purpose.** A driver maps queries, observes, acts, and produces
  artifacts. Caching, budgets, the ledger, reporting, retries — all
  runner-side, identical across drivers. A driver author writes the mapping,
  not a framework.
- **`SemanticNode.ref` is the currency**: queries resolve to refs, the agent
  targets refs, the locate cache stores query→ref recipes. Stable refs
  within a screen are the driver's one hard problem.
- **Conformance suite**: `e2e/driver` ships a reusable test suite
  (`verifyDriver(myDriver)`) that community drivers run in their own CI —
  the ecosystem's compatibility guarantee. Passing it is also what makes a
  *new* platform real: project the query vocabulary, observe, act — and
  every portable test runs.
- **Capabilities, not new fixtures.** A driver provides the shared
  surfaces (`app`, `screen`, observation/actions) plus the optional
  capabilities (`web`, `device`). Driver-defined fixture surfaces (e.g. an
  Electron IPC handle) are a roadmap design — in v0 the fixture set stays
  e2e-owned.

## Consequences elsewhere in the spec

- `expect(locator)` matchers exist and are cross-platform (03) — they
  project onto the backend's assertion mechanics the same way queries do.
- No browser/context/page object appears anywhere in the public API — the
  framework is not committed to Playwright (or any backend) long-term.
- The instant-action locate cache stores `screen`-shaped queries (10),
  which drivers replay through the same projection — one resolution path
  for cached agent actions and hand-written deterministic steps.
