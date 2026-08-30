# RFC0001 — proposed API surface

Companion to [`RFC0001.md`](./RFC0001.md). Everything here is an illustrative
sketch: names are bikesheddable, shapes are the point. Organized by the three
questions a reader will ask: how do I write tests, how do I define an agent,
how do I extend it — and then how the harness actually runs a step.

## Entry points

| Import | Audience | Contents |
|---|---|---|
| `e2e` | test writers | `test`, `agent`, `credentials`, `defineConfig` |
| `e2e/agent` | brain builders | `createAgent`, `defineTool`, `StepExecutor` types |
| `e2e/backend` | device-layer builders | `defineBackend`, session SPI |
| `@e2edev/playwright` | default | web backend |
| `@testerarmy/agent` | customers | the production executor (private, closed npm) |
| `create-e2e-agent` | brain builders | scaffold generating a working minimal agent |

## 1. Writing tests

```ts
// tests/checkout.e2e.ts
import { test, agent, credentials } from 'e2e';

test('member upgrades to Pro', { tags: ['billing'] }, async () => {
  await agent.login(credentials.user('member'));
  await agent.act('open billing settings and upgrade to the Pro plan');
  await agent.act('complete payment', { files: ['./fixtures/test-card.png'] });
  await agent.screenshot('post-upgrade');                    // deterministic, zero model
  await agent.evaluate(() => localStorage.getItem('plan'));  // deterministic, in-page
  await agent.assert('the billing page shows Pro as active');
});
```

Each `agent.*` call is one **step**, and the step kinds mirror the platform's
existing vocabulary (`act`, `assert`, `login`, `files`, `screenshot`,
`javascript`, `microphone`). Dashboard-native tests and code-native tests are the same
program in two forms; neither is second-class.

```ts
// e2e.config.ts
import { defineConfig } from 'e2e';
import testerarmy from '@testerarmy/agent';        // or: myAgent from './agents/mine'

export default defineConfig({
  target: { url: process.env.APP_URL!, platform: 'web' },
  backend: 'playwright',                            // the device layer
  executor: testerarmy,                             // ← THE SOCKET (the build-vs-buy line)
  cache: process.env.CI ? 'read-only' : 'read-write',
  budgets: { stepTimeoutMs: 120_000, maxToolCallsPerStep: 50 },
});
```

## 2. Defining a testing agent

### The golden path — `createAgent`, AI SDK all the way down

A complete, working brain:

```ts
// agents/my-agent.ts
import { createAgent } from 'e2e/agent';
import { anthropic } from '@ai-sdk/anthropic';

export default createAgent({
  model: anthropic('claude-sonnet-5'),              // any AI SDK LanguageModel
  system: ({ step, platform }) => `
    You are a QA agent testing a ${platform} app.
    Current step: "${step.instruction}".
    Observe, act with the tools, then conclude with complete_step.`,
});
```

`createAgent` returns a `StepExecutor`. Model, provider, middleware, and
prompt are the builder's; the tool loop, budgets, recording, and policy are
the harness's.

### The raw socket — for brains that are not AI SDK loops

This is the contract `createAgent` compiles down to, and the honest
definition of "executor":

```ts
import type { StepExecutor } from 'e2e/agent';

const myBrain: StepExecutor = {
  name: 'my-brain',
  version: '1',

  async runStep(ctx) {
    // ctx.step        → { index, type: 'act' | 'assert' | ..., instruction, params }
    // ctx.observe()   → Observation: a11y tree (+ screenshot on request); node refs are
    //                   revision-bound to this observation, not stable across turns
    // ctx.actions     → THE GRAMMAR: policed, budgeted, recorded primitives
    //                   (click/type/press/scroll/navigate/upload; canonical target union)
    // ctx.tools       → a toolset built over ctx.actions — the default lean pack, or
    //                   whatever this agent shipped instead (replaceable wholesale)
    // ctx.ledger      → bounded summaries of prior steps (incl. "replayed from cache")
    // ctx.budgets     → { remainingActions, deadline }
    // ctx.secrets     → resolve-by-purpose handles; plaintext never passes through the brain
    // ctx.signal      → cancellation

    const obs = await ctx.observe();
    await ctx.actions.click({ role: 'button', name: 'Upgrade' });
    return { status: 'passed', summary: 'Upgrade flow completed' };
    // or: { status: 'failed', errorCode: 'element_not_found', evidence: { ... } }
  },
};
```

**The load-bearing rule: the brain never touches the backend.** Every action
bottoms out in `ctx.actions` — the grammar — where the harness validates
policy, spends budget, dispatches to the device, appends the ledger, and
records for the cache. Toolsets, including TesterArmy's private one, are
sugar over the grammar and replaceable wholesale; that is why caching,
security, and receipts behave identically under any brain — ours, a
customer's, or the 150-line scaffold.

## 3. Extending

### Add a tool — AI SDK `tool()` plus the e2e semantics annotation

```ts
import { tool } from 'ai';
import { z } from 'zod';
import { defineTool } from 'e2e/agent';

export const seedCart = defineTool(
  tool({
    description: 'Seed the cart with a SKU via the store test API',
    inputSchema: z.object({ sku: z.string() }),
    execute: async ({ sku }, { session }) => session.fetch('/api/test/cart', { sku }),
  }),
  { replay: 'deterministic', mutates: true, secrets: false },
);

export default createAgent({ model, system, tools: { seedCart } }); // merged with ui_*
```

The annotation is required: an extension that does not declare its semantics
is cache-excluded and untrusted by default (RFC0001, Layer 2).

### Custom tools reach every agent, not just the test runner

A project-specific capability — put the phone in airplane mode, simulate
physics, seed a tenant, flip a feature flag — is defined once and consumed
three ways:

1. **the testing agent**, during runs;
2. **the coding agent**, during development — `e2e mcp` serves the project's
   extension tools alongside the `ui_*` vocabulary, so the agent building the
   feature has the same hands the test will later use;
3. **the cache/replay layer**, per the tool's declared semantics.

The `e2e/tools/` directory thereby becomes the app's *testability surface*: a
versioned, in-repo definition of everything an agent — any agent — may do to
this app. Running `e2e mcp` is effectively auto-generating a project-specific
MCP server from your test setup.

The annotations travel with the tool everywhere: a `mutates: true` tool is
policy-checked, budgeted, and recorded identically in a test run and a
dev-loop session. And because dev-loop tool calls are recorded through the
same pipeline, a development session can seed tests and cache — what the
coding agent did while building becomes what the test replays.

(The built-in mobile vocabulary already carries device controls — network
conditions, location — so "airplane mode" is nearly a built-in; extensions go
beyond the device into the app: physics hooks, debug endpoints, data seeding.)

### Shape a turn — per-call gating and prompt control

The production agent's prepare-step pattern, exposed:

```ts
createAgent({
  model,
  system,
  prepareCall: ({ step, observation, callIndex }) => ({
    activeTools: step.type === 'assert' ? ['ui_verify_text', 'complete_step'] : undefined,
    system: callIndex > 10 ? escalationPrompt : undefined,
  }),
});
```

### Wrap the model — plain AI SDK middleware

```ts
model: wrapLanguageModel({ model, middleware: [logging, guardrails] })
```

Nothing e2e-specific; the AI SDK's own extension surface is the extension
surface.

### Add a device layer — the backend SPI

```ts
import { defineBackend } from 'e2e/backend';

export default defineBackend({
  id: 'my-appium',
  platforms: ['android'],
  async connect(target) {
    // implement the session SPI; the ui_* vocabulary maps onto it automatically
    return { snapshot, click, type, press, scroll, navigate, upload, screenshot, dispose };
  },
});
```

## 4. How it works — one step's journey

```
 test file ──▶ harness: next step ──▶ cache key (test + step + instruction digest
                                       + platform + vocab/policy version)
                    │
        ┌───────────┴────────────┐
   CACHE HIT                CACHE MISS
        │                        │
   replay recorded          executor.runStep(ctx)     ← the socket; brain thinks here
   actions zero-model,           │
   verifying each target    every grammar action:
        │                   policy check → budget spend → backend dispatch
   diverged? (target gone,       → ledger append → RECORD for cache
   state mismatch)               │
        │── yes ──▶ hand step to executor MID-STEP,   ← adaptive: cache → agent → recapture
        │           ledger says what already replayed
        no                       │
        │                   step passed? → write trace to .e2e/cache/  (read-write only)
        ▼                        ▼
   step result ──▶ ledger ──▶ report.json (the receipt) ──▶ exit code / CI / cloud upload
```

Enforced by the harness regardless of brain: budgets, tool policy per step
type, secret resolution only at authorized sinks, action recording at the
tool boundary, cache mode, the report. Owned entirely by the brain: which
tools to call, when to observe, what the model sees, when to conclude.
Swapping `@testerarmy/agent` for `./agents/mine` changes only the thinking —
never the safety, the cache, or the receipt.

The dev loop rides the same stack: `e2e mcp` exposes the vocabulary tools
over the configured backend for a coding agent to drive directly — same
session, same recording — so what the agent learns while building becomes
tomorrow's cache.
