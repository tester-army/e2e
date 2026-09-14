# Agent steps

`agent` is a fixture like `screen` and the main way a test drives the app.
Each call is one bounded invocation: a fresh redacted observation, a
deadline, a model-call budget, and no shared transcript between calls. A
test with no agent step never loads a model.

## Configure a model

Agents live under `agents` by name; `default` is the one tests use, `e2e run --agent <name>` re-points that default, a test or describe pins one with `{ agent: 'name' }` or several with `{ agent: ['buyer', 'admin'] }` (the test runs once per agent, one result each, tagged `[admin]` in the terminal and `agent` in the report), and any `agent.*` call can name one with `{ agent: 'name' }` (innermost wins). `--agent buyer,admin` runs every unpinned test once per agent; on a pinned list it narrows to the names both give and never overrides a pin it does not name. A signed-in persona pairs the pin with a `session`, one per describe block, so a loop over describe blocks sweeps signed-in personas. There is no default model. Pick one of three shapes for an entry:

```ts
// e2e.config.ts
import { createAgent } from 'e2e/agent';
import { gateway } from 'ai';

export default {
  // 1. The built-in agent with an AI SDK model: gateway() from 'ai' is the Vercel AI Gateway and reads AI_GATEWAY_API_KEY.
  agents: { default: createAgent({ model: gateway('openai/gpt-5.6-luna'), system: 'You are a thorough QA agent. Verify every outcome on screen.' }) },

  // 2. An options block: a model plus project vocabulary. openrouter() from '@openrouter/ai-sdk-provider' reads OPENROUTER_API_KEY.
  // agents: { default: { model: openrouter('anthropic/claude-sonnet-4.5'), context: 'A billing dashboard. Plans are Free, Team, and Pro.' } },

  // 3. A live AI SDK model instance for a provider called directly.
  // agents: { default: createAgent({ model: openai('gpt-5.6-luna') }) },
} satisfies E2EConfig;
```

```bash
AI_GATEWAY_API_KEY=... npx e2e run
```

- The model is always an AI SDK instance the config constructs; the runner
  implies no gateway and reads no model variable. `gateway()` from `ai` is the
  Vercel AI Gateway, `openrouter()` from `@openrouter/ai-sdk-provider` is
  OpenRouter, `createOpenAICompatible({ baseURL }).chatModel()` from
  `@ai-sdk/openai-compatible` is any /v1 chat endpoint (Ollama, vLLM), and a
  provider's own package (`openai()`) calls it directly. Each reads its own
  key variable. A string in a model slot is `INVALID_CONFIG`.
- With no model anywhere, acquiring `agent` is `MODEL_UNAVAILABLE`. Use
  `createAgent` for the model, a `system` prompt, and tools.
- `ai@^7` must be installed for any `agent.*` step; the runner loads it
  lazily and fails without it.
- `context` in the config and `agentContext` on a test or group add trusted
  project vocabulary to every prompt.
- The model passed to `createAgent({ model })` is the one model for every
  `agent.*` call, `act` and the judgments alike.
  An agent `model` naming a different model is `INVALID_CONFIG`.
- Missing model or key: checked once per run when the first test acquires
  the `agent` fixture. One run-level `MODEL_UNAVAILABLE` (exit 2) stops the
  run; the remaining tests are skipped, not failed one by one.

## act: one goal

```ts
import { credentials } from 'e2e';

await agent.act('add a todo named "Buy milk" and mark it done');
await agent.act('invite {email} as an editor', { params: { email: 'ada@example.test' } });

const member = credentials.user('member');
await agent.act('sign in with the given credentials', {
  params: {
    username: member.username,
    password: member.password, // a Secret: the model sees its name, the runner fills the field
  },
});
```

`act(instruction, options?)` plans and performs a multi-action flow and ends
in a verdict. Passed resolves with what the step did: `summary`, `modelCalls`,
`actions`, and `cache` (how the trace cache took part). Failed or blocked
throws an `AgentError` whose `code` says why: `ACTION_FAILED` for a plain
failure, `STEP_BUDGET_EXHAUSTED` or `STEP_TIMEOUT` when the budget or the
clock ran out, and a blocked code (`AUTH_CREDENTIAL_UNAVAILABLE`,
`ENVIRONMENT_UNAVAILABLE`, `SEED_DATA_MISSING`, `TEST_SETUP_FAILED`,
`AUTOMATION_UNSUPPORTED`) when something outside the product prevented a
verdict.

Options: `params` (the values the instruction refers to; a `Secret` is filled
by the runner), `timeout` (default the test timeout), `maxSteps` (default 25
actions), `maxModelCalls` (default 25). Per-call budgets can only lower the
configured limits. `act` takes no `schema`: structured output is
`extract({ schema })`. By default pixels reach an `act` step through the
`screenshot` and `tap_at` tools the agent offers while no secret has been
filled. `screenshot` attaches the viewport's pixels to the result and turns
on pixel mode, where every action result carries a fresh screenshot; `tap_at`
taps a point in the latest screenshot (a canvas shape, a map pin, an image
region, a control in a system sheet), hit-tested against the tree first so a
listed control is tapped by id. A screen with nothing to tap by id opens with
a screenshot already attached. `vision: true` attaches a screenshot from the
first turn instead of waiting for the model to ask.
On an engine with a keyboard (browser and device), `type` and `press` also
take no target and reach whatever has focus: `tap_at` a field the tree does
not list, then `type` without a target; a device adds `dismiss_keyboard`.
`vision: 'only'` withholds the tree: the model sees screenshots alone and
acts through `tap_at`, `type_at`, `press_at`, `select_at`, and `scroll` at
points, each resolved onto the listed control underneath, and `type_at` on
a point with nothing listed taps it and types through the keyboard. Use it for a
canvas, a game, or a native screen without accessibility exposure; a step
with a `Secret` in its params or on a viewport an earlier fill tainted fails
with `POLICY_DENIED`, so sign in with the tree first.

## assert, waitFor, extract: one question

```ts
import { z } from 'zod';

await agent.assert('the dashboard shows a trial badge'); // one look, one judgment

await agent.waitFor('the export finished and a download link appeared', { // polls
  interval: 500,
  timeout: 120_000,
});

const data = await agent.extract('every todo title and how many remain', { // structured output
  schema: z.object({ titles: z.array(z.string()), remaining: z.number().int() }),
});
expect(data.titles).toContain('Buy milk');
```

- `assert` does not poll. A false judgment is `ASSERTION_FAILED` with the
  model's explanation and a screenshot in the report. A judgment the screen
  did not show enough to decide is `ASSERTION_INCONCLUSIVE`, also a failure:
  open or wait for the right screen first, and ask about what is visible.
  Malformed output gets one repair round, then `MODEL_OUTPUT_INVALID`.
- Judgments see the assertion and the current screen only, never the steps
  before or the act loop's summaries. `judge` in the agent config names a
  separate model for them; unset, they use `model`.
- `waitFor` observes every `interval` (default 3 s) and spends a judgment
  only when the screen changed; `STEP_TIMEOUT` after `timeout` (default
  30 s).
- `extract` accepts any Standard Schema validator (zod works). Invalid output
  gets one repair round, then `MODEL_OUTPUT_INVALID`.
- Judgments are never cached and always read a fresh observation.

`vision` on a judgment controls the evidence: `false` (the default) the
semantic tree; `true` the tree plus a masked screenshot; `'only'` the
screenshot alone. Use `'only'` for a question about what the screen presents (an
overlay, a broken layout, a chart), because the tree would otherwise answer
first. Pixels show the viewport only and are withheld once a secret was
filled in the attempt.

## Write instructions the model can execute

- One goal per `act`. The order of goals is the test's; the path inside a
  goal is the model's.
- Use the words on screen: `'open the Billing tab and choose the Pro plan'`,
  not `'upgrade'` when no control says so.
- Values go in params, never in the sentence:
  `act('rename the project to {name}', { name })`. The runner does not
  expand `{name}`; the model receives the instruction as written plus the
  params as a separate block and reads the value from there.
- Give vocabulary once, in `agent.context` or `agentContext`, instead of
  repeating it in every instruction.
- Do not describe mechanics the runner already handles: waiting, scrolling
  into view, retries.
- Pin the outcome of every `act` deterministically, right after it:

```ts
await agent.act('create a workspace named "Atlas" on the Pro plan');
await expect(screen.getByRole('status')).toHaveText('Created "Atlas" on the Pro plan');
```

The check makes the test model-portable (the path may differ between models,
the end state may not), and it is what lets the trace cache record the step.

State the step writes off screen (a database row, an API read) can land after
`act` returns; poll the read instead of sleeping:

```ts
await agent.act('create a test named "AI checkout regression"');
await expect.poll(() => getTest(workspace).then((row) => row?.title), { timeout: 15_000 }).toBe('AI checkout regression');
```

## What the model sees

A redacted snapshot of the screen (roles, names, text, states), a summary of
prior steps, and your context. The first screen of a step arrives whole;
every action result after it reports what changed, keyed by node ids that
stay stable while an element exists, or the whole screen again when most of
it changed, and is read after the action's effect landed. Never raw HTML,
cookies, headers, environment
values, or a `Secret`'s value; password fields arrive masked. Pixels reach a
model only through `vision` on a judgment or the act loop's `screenshot` and
pixel mode, masked, and only while no secret has been filled. Nothing the model
returns runs as code or selectors: the runner validates and authorizes every
tool call before it executes.

## Budgets and cost

| Call | Model calls | Default timeout |
| --- | ---: | --- |
| `act` | up to `agent.maxModelCalls` (25) | the test `timeout`, 120 s |
| `assert` | 2 | 30 s |
| `extract` | 2 | 30 s |
| `waitFor` | up to `agent.maxModelCalls` (25) | 30 s |

- With the cache on, a passing `act` costs model calls once and replays on
  later runs until the app changes. Budget for the runs where the UI moved,
  not for every run.
- Slow providers: raise the test `timeout` and `actionTimeout` (each
  observation and action inside a step is bounded by it) rather than reading
  latency as a defect. `STEP_TIMEOUT` and `STEP_BUDGET_EXHAUSTED` are test
  failures: scope the goal smaller or split it.
- `--debug` prints a per-step table (duration, model calls, tokens, cost)
  after the run and saves each step's transcript as an artifact.

## The trace cache

Each passing `agent.act` records the actions it performed. The next run
replays them with zero model calls and hands back to the live agent the
moment the app no longer matches the recording, or when the recorded end
state is not on screen after the replay. Replayed actions run as a test's
own steps do, without the agent's settle wait, so a replay is as fast as
the deterministic equivalent.

- On by default (`read-write`), `read-only` in CI, `cache: 'off'` in the
  config or `--no-cache` on a run to disable. Entries live in `.e2e/cache/`;
  deleting the directory only slows the next run.
- An entry is written only after a later verification step passes: a
  locator or engine `expect` matcher, `locator.waitFor`, `web.waitForURL`,
  `agent.assert`, or `agent.waitFor`. A plain-value `expect`, `expect.poll`,
  `agent.extract`, another `act`, or the attempt passing confirms nothing.
  An `act` nothing checks is never replayed.
- A replay needs the app on the path the step was recorded on, unless the
  recording opens with a navigation. It re-finds each control by role, name,
  test id, placeholder, and input purpose, and passes on its own only when
  the recorded end path and the controls that appeared during the step are
  back. Otherwise the agent takes over mid-step. The report's
  `step.cache.reason` says why: `no-entry`, `wrong-context`,
  `target-not-found`, `target-ambiguous`, `end-mismatch`, and so on.
- A step that records no actions creates no entry and skips the cache's
  end-state observation.
- `e2e init` gitignores `.e2e/cache/`; committing entries is opt-in. Remove
  that line to share replays with CI and teammates (CI stays `read-only`
  unless `cache: 'read-write'` is set explicitly).
- A failing run evicts the entries it implicates. To rule the cache out of a
  failure, run with `--no-cache`.

## Inspect what the model did

```bash
npx e2e run tests/checkout.e2e.ts --debug      # step table, transcripts as artifacts
npx e2e run tests/checkout.e2e.ts --ai-trace   # writes .e2e/ai-trace.json
npx unbox-ai runs .e2e/ai-trace.json                        # one line per agent step
npx unbox-ai summary .e2e/ai-trace.json --run 0             # turns, tokens, tool calls of one step
```

Never read `.e2e/ai-trace.json` directly; it is megabytes of resent context.
Use `--no-cache` when the whole flow should be traced, since replayed steps
make no model calls.

The trace replaces inline bytes and base64 in SDK image and file message
parts with decoded byte counts. URLs and text remain; encoded strings in
arbitrary tool result JSON or other fields are preserved.

## Make the agent yours

The agent in the config is a starting point. The best agent for an app is
the one that knows its screens, and that comes from iterating on it:

1. **The goal.** A failed step usually means the goal named something the
   screen does not. Reword it with the labels on screen. Check the step's
   transcript with `--debug` to see what the model saw and tried.
2. **`context`.** Vocabulary every step needs: what the plans are called,
   what a "workspace" is, which tab holds billing. Set it once on the agent
   or per test with `agentContext`, not in every instruction.
3. **`system` on `createAgent`.** How the agent works: how carefully it
   verifies, what it never does, how it treats a modal. A UX reviewer, a
   cautious QA persona, and a fast smoke agent are three `system` prompts on
   the same model.
4. **Tools.** A test API the agent may call mid-flow (seed a cart, mint a
   coupon) via `createAgent({ tools })`; see below.
5. **The model and its options.** `providerOptions` for reasoning effort,
   or a different model for one persona. `npx e2e run --agent <name>` runs
   the suite as any configured agent, so two candidates can be compared on
   the same tests; every result records which agent ran it.

Personas are agents by name under `agents`, pinned with `{ agent }` on a
test or block, or swept with `--agent buyer,admin`. The trace cache records
per agent step, so a specialised agent gets the same replay benefit.

## Beyond the built-in agent

- `createAgent({ tools: { seedCart } })` adds AI SDK tools wrapped with
  `defineTool(tool({ ... }), { mutates: true })` from `e2e/agent`, so
  a flow can call a test API mid-step.
- `createToolLoopExecutor` keeps the loop and replaces the prompt and the
  tool vocabulary.
- Any object implementing `StepExecutor` (`{ name, version, cache, runStep(ctx) }`)
  can be the `agent`; the runner still owns observations, actions, budgets,
  and the report.

Full reference: https://docs.e2e.army/agents

## In CI

One suite, one job, on every pull request, agent steps included. Pass the
key the config's model reads (`env: { AI_GATEWAY_API_KEY }` for `gateway()`)
from secrets. Commit `.e2e/cache/` so CI replays recorded steps with no
model call and consults the model only where the app changed; keep every
`act` followed by a check so the recording is trusted. CI retries once and
reports a pass-on-retry as flaky, so the report keeps naming the goals that
need tightening.
