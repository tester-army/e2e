# Agent steps

`agent` is a fixture like `screen`. Each call is one bounded invocation: a
fresh redacted observation, a deadline, a model-call budget, and no shared
transcript between calls. Deterministic tests never load a model.

## Configure a model

There is no default model. Pick one of three shapes:

```ts
// e2e.config.ts
import { createAgent } from '@e2edev/e2e/agent';

export default {
  // 1. The built-in agent; the model comes from E2E_MODEL at run time.
  agent: createAgent({ system: 'You are a thorough QA agent. Verify every outcome on screen.' }),

  // 2. An options block: a gateway model string plus project vocabulary.
  // agent: { model: 'anthropic/claude-sonnet-4.5', context: 'A billing dashboard. Plans are Free, Team, and Pro.' },

  // 3. A live AI SDK model instance for a provider called directly.
  // agent: createAgent({ model: openai('gpt-5.4-mini') }),
} satisfies E2EConfig;
```

```bash
E2E_MODEL=anthropic/claude-sonnet-4.5 E2E_MODEL_API_KEY=... npx --no-install e2e run
```

- A `provider/model-id` string is routed through the Vercel AI Gateway; one
  `E2E_MODEL_API_KEY` (or `AI_GATEWAY_API_KEY`) reaches every provider.
- With no `agent` key at all, the built-in agent still runs and takes its
  model from `E2E_MODEL`. Use `createAgent` for a `system` prompt, tools, or
  a pinned model.
- `ai@^7` must be installed for any `agent.*` step; the runner loads it
  lazily and fails without it.
- `context` in the config and `agentContext` on a test or group add trusted
  project vocabulary to every prompt.
- `visionModel` (or `E2E_VISION_MODEL`) serves the calls that send pixels.
- The model passed to `createAgent({ model })` is the one model for every
  `agent.*` call, `act` and the judgments alike, and outranks `E2E_MODEL`.
  An `agent.model` naming a different model is `INVALID_CONFIG`.
- Missing model or key: checked once per run when the first test acquires
  the `agent` fixture. One run-level `MODEL_UNAVAILABLE` (exit 2) stops the
  run; the remaining tests are skipped, not failed one by one.

## act: one goal

```ts
import { credentials } from '@e2edev/e2e';

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
configured limits. `act` takes no `schema` and no `vision`: structured output
is `extract({ schema })`, and `vision` belongs to the judgments.

## assert, waitFor, extract: one question

```ts
import { z } from 'zod';

await agent.assert('the dashboard shows a trial badge'); // one look, one judgment

await agent.waitFor('the export finished and a download link appeared', { // polls
  intervalMs: 500,
  timeout: 120_000,
});

const data = await agent.extract('every todo title and how many remain', { // structured output
  schema: z.object({ titles: z.array(z.string()), remaining: z.number().int() }),
});
expect(data.titles).toContain('Buy milk');
```

- `assert` does not poll. A false judgment is `ASSERTION_FAILED` with the
  model's explanation and a screenshot in the report. Malformed output gets
  one repair round, then `MODEL_OUTPUT_INVALID`.
- `waitFor` observes every `intervalMs` (default 3 s) and spends a judgment
  only when the screen changed; `STEP_TIMEOUT` after `timeout` (default
  30 s).
- `extract` accepts any Standard Schema validator (zod works). Invalid output
  gets one repair round, then `MODEL_OUTPUT_INVALID`.
- Judgments are never cached and always read a fresh observation.

`vision` on a judgment controls the evidence: `false` (default) the semantic
tree; `true` the tree plus a masked screenshot; `'only'` the screenshot
alone. Use `'only'` for a question about what the screen presents (an
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

## What the model sees

A redacted snapshot of the screen (roles, names, text, states), a summary of
prior steps, and your context. Never raw HTML, cookies, headers, environment
values, or a `Secret`'s value; password fields arrive masked. Pixels only
with `vision`, and only while no secret has been filled. Nothing the model
returns runs as code or selectors: the runner validates and authorizes every
tool call before it executes.

## Budgets and cost

| Call | Model calls | Default timeout |
| --- | ---: | --- |
| `act` | up to `agent.maxModelCalls` (25) | the test `timeout`, 120 s |
| `assert` | 2 | 30 s |
| `extract` | 2 | 30 s |
| `waitFor` | up to `agent.maxModelCalls` (25) | 30 s |

- Keep `agent.*` for steps whose path or wording varies; `expect` and
  `screen` are free.
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
state is not on screen after the replay.

- On by default (`read-write`), `read-only` in CI, `cache: 'off'` in the
  config or `--no-cache` on a run to disable. Entries live in `.e2e/cache/`;
  deleting the directory only slows the next run.
- An entry is written only after a later verification step passes
  (`expect`, `locator.waitFor`, `agent.assert`, `agent.waitFor`). An `act`
  nothing checks is never replayed.
- A step that records no actions creates no entry and skips the cache's
  end-state observation.
- `e2e init` gitignores `.e2e/cache/`; committing entries is opt-in. Remove
  that line to share replays with CI and teammates (CI stays `read-only`
  unless `cache: 'read-write'` is set explicitly).
- A failing run evicts the entries it implicates. To rule the cache out of a
  failure, run with `--no-cache`.

## Inspect what the model did

```bash
npx --no-install e2e run tests/checkout.e2e.ts --debug      # step table, transcripts as artifacts
npx --no-install e2e run tests/checkout.e2e.ts --ai-trace   # writes .e2e/ai-trace.json
npx unbox-ai runs .e2e/ai-trace.json                        # one line per agent step
npx unbox-ai summary .e2e/ai-trace.json --run 0             # turns, tokens, tool calls of one step
```

Never read `.e2e/ai-trace.json` directly; it is megabytes of resent context.
Use `--no-cache` when the whole flow should be traced, since replayed steps
make no model calls.

The trace replaces inline bytes and base64 in SDK image and file message
parts with decoded byte counts. URLs and text remain; encoded strings in
arbitrary tool result JSON or other fields are preserved.

## Beyond the built-in agent

- `createAgent({ tools: { seedCart } })` adds AI SDK tools wrapped with
  `defineTool(tool({ ... }), { mutates: true })` from `@e2edev/e2e/agent`, so
  a flow can call a test API mid-step.
- `createToolLoopExecutor` keeps the loop and replaces the prompt and the
  tool vocabulary.
- Any object implementing `StepExecutor` (`{ name, version, cache, runStep(ctx) }`)
  can be the `agent`; the runner still owns observations, actions, budgets,
  and the report.

Full reference: https://e2e-docs.vercel.app/agents

## In CI

Deterministic tests gate merges; agentic tests are opt-in. Keep them in a
separate config (`e2e.agent.config.ts` with its own `tests` glob and a larger
`timeout`), run them on a schedule or `workflow_dispatch`, and pass the model
through `env: { E2E_MODEL, E2E_MODEL_API_KEY }` from CI variables and
secrets.
