# 02 — Core Test API

## `test()`

The single test primitive. A test file default-exports (or named-exports) one
or more tests.

```ts
import { test } from 'e2e';

export default test('user can sign up', async ({ app, agent }) => {
  await app.open();

  await agent.act('sign up as a new user');

  await agent.assert('the dashboard is visible');
});
```

### Signature

```ts
test(title: string, fn: TestFn): TestCase;
test(title: string, options: TestOptions, fn: TestFn): TestCase;
```

### `TestOptions`

```ts
type TestOptions = {
  /** Per-test timeout in ms. Default: config.timeout (120_000). */
  timeout?: number;
  /** Per-test retries. Default: config.retries. */
  retries?: number;
  /** Tags for filtering: `npx e2e run --tag smoke`. */
  tags?: string[];
  /** Skip with a reason (shown in reports). */
  skip?: boolean | string;
  /** Run only this test (local dev convenience). */
  only?: boolean;
  /**
   * Platforms this test can run on. Default: all configured targets.
   * Required implicitly when using `device` (mobile) or platform-specific
   * flows. Open vocabulary — driver-provided ids work (08-platforms.md).
   */
  platforms?: Platform[];
  /** Start from a saved session (see 11-lifecycle.md). */
  session?: string;
  /** Ambient agent context for this test, appended to config agent.context. */
  agentContext?: string;
};
```

### Modifiers

```ts
test.skip('title', fn);          // always skipped
test.only('title', fn);          // focus locally
test.setup('title', fn);         // setup test producing sessions (see 11-lifecycle.md)
```

Post-v0 (see roadmap): `test.fixme`, `test.each`, `test.skipIf`/`failsIf`,
`test.extend`.

## Fixtures

The test function receives a destructurable fixtures object. Fixtures are
lazy: nothing is created until first accessed.

```ts
type TestFixtures = {
  agent: Agent;            // AI agent bound to the current target
  app: App;                // portable app handle: open/restart/deepLink/screenshot
  screen: Screen;          // deterministic cross-platform queries — zero AI
  platform: Platform;      // current target's platform id ('web' | 'ios' | 'android' | driver-provided)
  session: Session;        // save/restore app state (see 11-lifecycle.md)
  web: Web;                // web capability — targets whose driver provides it
  device: Device;          // mobile system utils — targets whose driver provides it
};
```

`screen` is the deterministic cross-platform layer — Testing Library
queries projected onto each platform's backend, zero model calls
(08-platforms.md):

```ts
export default test('checkout', async ({ screen, agent }) => {
  await screen.getByRole('link', { name: 'Pricing' }).tap();   // deterministic, cross-platform
  await agent.act('buy the pro plan with the test card');      // agentic
});
```

Every fixture except `web` and `device` is platform-agnostic; `app.open()`
is the portable navigation (target URL on web, app launch on mobile). `web`
carries the Playwright-parity capabilities with no mobile meaning
(navigation, css, network interception, dialogs — see 08-platforms.md).
Backends (Playwright, native drivers, …) are internal to drivers and never
exposed in the API.

## `agent`

The agent performs actions against the current target. On web it sees the
page (DOM + screenshot) and acts via the browser; on mobile it sees the
native accessibility tree + screenshot and acts via the native driver. Same
contract everywhere.

Execution model: **the test code drives; each `agent.*` call is a bounded,
isolated sub-agent invocation**. Continuity between calls comes from the
step ledger (compact handoff summaries — "login already happened"), not
shared transcripts; values move explicitly through code. See
10-determinism.md, "Execution model".

The agent API has **two tiers** (see 10-determinism.md):

- **Planning** — `agent.act('…')`: the agent plans and executes a multi-step
  flow. Maximum leverage, most model freedom.
- **Instant actions** — `agent.tap('…')`, `agent.type('…', value)`, …: AI is
  used for exactly one thing — *locating* the described element. The action
  itself is deterministic. One model call, faster, cheaper, cacheable, and
  minimal wiggle room.

Use instant actions when you know the steps; use `act()` when you know the
goal.

### `agent.act()`

```ts
agent.act(instruction: string, params?: AgentParams, options?: AgentOptions): Promise<AgentResult>;
```

- `instruction` — plain-English action ("buy the pro plan").
- `params` — structured values the agent may use. Values are passed verbatim
  (never invented): emails, codes, names, form data. Values may also be
  `Credential` handles (filled host-side by reference; the raw secret never
  enters model context).
- `options.timeout` — max ms for the whole action.
- `options.maxSteps` — action budget; on exhaustion the step is forced to
  conclude with `AgentError.code = 'STEP_BUDGET_EXHAUSTED'`.
- `options.cache` — use/record the cached action path for this instruction
  (default: config `agent.cache`; see 10-determinism.md).
- `options.schema` — a Standard Schema; extracted values in `result.data`
  are validated against it and typed.

```ts
await agent.act('create a project called "Rocketry" in the Engineering category');

await agent.act('invite a teammate as viewer', {
  email: 'ada@example.test',
});

// typed structured output
const { data } = await agent.act('add the three cheapest items to the cart', undefined, {
  schema: z.object({ addedItems: z.array(z.string()), total: z.number() }),
});
data.total; // number
```

Returns `AgentResult`:

```ts
type AgentResult<T = Record<string, unknown>> = {
  ok: true;
  steps: AgentStep[];      // what the agent actually did (for reports/replay)
  data?: T;                // extracted values; present + typed when a schema is passed
};

type AgentStep = {
  action: string;          // human-readable, e.g. 'tap "Sign up"'
  screenshot?: string;     // artifact path
  startedAt: Date;
  durationMs: number;
};
```

On failure the promise rejects with `AgentError` containing the step trail,
final screenshot, the agent's own explanation of what went wrong, and a
typed `code` separating setup failures from product failures (see
10-determinism.md).

### Instant actions — `tap`, `type`, `scroll`, `scrollTo`, `longPress`, `waitFor`

Granular, locate-then-act primitives. The target is a natural-language
description — never a selector — so instant actions stay cross-platform:

```ts
await agent.tap('the login button');
await agent.type('the email field', 'ada@example.test');
await agent.type('the search box', 'headphones', { submit: true });
await agent.scroll({ direction: 'down' });
await agent.scroll({ direction: 'down', momentum: 'fast', within: 'the plans list' });
await agent.scrollTo('the 20th item in the results list');
await agent.longPress('the message from Ada');
await agent.waitFor('the results list has loaded');
```

Signatures (target-first, always):

```ts
agent.tap(target: string, options?: InstantActionOptions): Promise<void>;
agent.type(target: string, value: string, options?: InstantActionOptions & { submit?: boolean; clear?: boolean }): Promise<void>;
agent.scroll(options: InstantActionOptions & { direction: ScrollDirection; momentum?: 'none' | 'slow' | 'fast'; within?: string }): Promise<void>;
agent.scrollTo(target: string, options?: InstantActionOptions & { direction?: ScrollDirection }): Promise<void>;
agent.longPress(target: string, options?: InstantActionOptions & { duration?: number }): Promise<void>;
agent.waitFor(condition: string, options?: { timeout?: number; interval?: number }): Promise<void>;

type ScrollDirection = 'up' | 'down' | 'left' | 'right';
type InstantActionOptions = {
  timeout?: number;
  /** Use/record the cached location for this target. Default: config.agent.cache. */
  cache?: boolean;
};
```

Semantics:

- **One model call**: locate the described element on the current screen.
  The tap/type/scroll itself is executed deterministically by the driver —
  no planning loop, no replanning, no alternate paths.
- `click()` is an alias of `tap()` for web muscle memory.
- **Locate caching**: successful locations are cached by target description
  (semantic node reference, validated on replay, AI fallback on mismatch) —
  repeat runs skip the model entirely. Stronger than `act()` path caching
  because there is no plan to invalidate.
- **Failures are precise and typed**: element not found or ambiguous →
  `AgentError` with the accessibility-tree evidence ("found 3 buttons
  matching 'the delete button'"). No self-healing detours: an instant
  action never does something else instead.
- Values are passed verbatim (like `AgentParams`): `agent.type` accepts
  `Credential` (filled host-side, never in model context) and plain
  strings.
- `waitFor(condition)` polls a natural-language condition (interval default
  3s) — for loading states where `agent.assert` would be premature.

### `agent.login()`

Sugar for the most common flow. Accepts a credential handle (see
04-resources.md) and gets the user authenticated, whatever the app's login UI
looks like.

```ts
const admin = credentials.user('admin');
await agent.login(admin);
```

```ts
agent.login(user: Credential, options?: AgentOptions): Promise<AgentResult>;
```

The credential is **pinned** for the step: the agent cannot substitute a
different one, and the secret is filled host-side by reference — it never
enters model context.

### `agent.extract()`

Pull structured data off the page without selectors.

```ts
const { total } = await agent.extract('the cart total as a number', {
  schema: z.object({ total: z.number() }),
});
```

```ts
agent.extract<T>(instruction: string, options: { schema: StandardSchema<T>; timeout?: number }): Promise<T>;
```

Schema is any Standard Schema (zod, valibot, arktype).

## Steps — the report structure, for free

There is no `step()` wrapper. Every `agent.*` call, `screen` action,
resource `expect()`, and `app.screenshot()` is a **step** in the report
timeline automatically, labeled by the call itself — `agent.act('sign up
as a new user')` is its own report line. Natural-language-first calls
self-document; no narration API needed (see 10-determinism.md). An
explicit grouping marker is roadmap if real suites show timeline noise.

## Hooks

Playwright-familiar, imported from the root:

```ts
import { test } from 'e2e';

test.beforeEach(async ({ app }) => {
  await app.open('/');
});

test.afterEach(async ({ app }) => {
  await app.restart(); // fresh state between tests when needed
});

test.beforeAll(fn);
test.afterAll(fn);
```

## Grouping

```ts
test.describe('billing', { tags: ['billing'], session: 'admin' }, () => {
  test('checkout works', async ({ agent }) => { /* … */ });
  test('invoice email arrives', async ({ agent }) => { /* … */ });
});

test.describe('onboarding wizard', { serial: true }, () => { /* ordered, shared state */ });
```

Group options apply to every test inside (test-level overrides). `serial`
groups run in order in one worker; a failure skips the rest. Details in
11-lifecycle.md.

## File conventions

- Default glob: `tests/**/*.e2e.ts`
- A file may export multiple tests (named or array default export).
- `export default test(…)` is the canonical single-test file shape.
