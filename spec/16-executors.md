# 16 — Step executors

Status: informative for `sdk-0.1` (the socket ships; conformance IDs land with
a later suite version). Canonical types: the executor section of
[api/e2e.d.ts](./api/e2e.d.ts), including `BLOCKABLE_CODES`. The `e2e/agent`
value exports (`createToolLoopExecutor`, `defineTool`) are package API documented in the
product docs; they are not spec-canonical in this version. Direction: RFC0001.

## Philosophy

A planned step (`agent.act`) separates two responsibilities that most agentic
test tools fuse:

- **The harness owns the step.** It captures and redacts observations,
  performs every action, enforces the deadline, the action budget, origin
  policy, and secret rules, and records everything into the ledger and the
  report.
- **The executor owns the thinking.** It reads observations, chooses actions,
  and concludes with a verdict. Nothing else.

The consequence is the portability promise: swapping executors changes only
the thinking — never safety, budgets, recording, or what a report means. A
test written against `agent.act` survives moving from one executor to a
hand-rolled one, to a vendor's, and back.

## The socket

```ts
interface StepExecutor {
  readonly name: string;
  readonly version?: string;
  runStep(context: StepExecutorContext): Promise<StepVerdict>;
}
```

One step in, one verdict out. Two step kinds cross the socket, the second
only when `agent.judgments` is `'executor'` (05-config.md): `act` (plan
and execute a flow) and — when a custom executor is configured — `assert`
(judge a condition without changing application state; a code-less failure
maps to `ASSERTION_FAILED`). Deterministic kinds never cross it: screenshots
and script evaluation are `app.screenshot` and `web.evaluate`, zero-model by
construction. The context provides:

- `step` — the kind, instruction, JSON-safe params, and declared secrets. A
  `Secret` param is projected to `{ kind: 'secret', name, purpose }`; the
  plaintext is only ever reachable through `actions.typeSecret`, which runs
  the full secret authorization policy of 14-security.md.
- `observe()` — a fresh, redacted, size-bounded semantic observation, with the
  current location as `path` when the backend reports one.
- `actions` — the action grammar (`tap`, `type`, `press`, `select`, `scroll`,
  `navigate`), addressed by node ids from the newest observation. Every call
  is checkpointed against the deadline and the action budget, policed, and
  recorded as a step event. Each underlying driver operation — actions and
  observations alike — is additionally bounded by `actionTimeout`, so a
  single page that never settles costs one action timeout and a clearly
  attributed failure, never the step's whole clock. Actions and observations are serialized in call
  order: a call issued while another is in flight queues behind it, so a
  batch of parallel tool calls cannot race two mutations against one stale
  observation — the second resolves against the newest one and a stale id
  fails loud.
- `budgets` — limits plus `recordModelCall(usage?)`, which feeds step metrics
  and model provenance in the report, including `estimatedCostUsd` when the
  provider bills per request.
- `model` — the config-resolved AI SDK model, which an executor may ignore.
- `ledger`, `agentContext`, `signal`.
- `replayedPrefix` — present exactly when a cached replay ran part of this
  step before diverging (10-determinism.md). Prose in, not structs in: the
  executor sees ordered action summaries, the counts, and one closed
  `stopReason` token — never descriptors, outputs, or error objects. The
  replayed actions already ran against the live app under this step's own
  budgets and recording; the executor MUST continue from current application
  state and MUST NOT redo them. An `action-uncertain` stop additionally
  carries `uncertainAction` — the summary of a replayed action whose input
  may have reached the app (09-drivers.md, `ACTION_MAY_HAVE_COMMITTED`); the
  executor MUST verify current state before re-attempting anything like it.
  On a miss, or with caching off, the field is absent and the step is
  indistinguishable from an uncached one.

The interface never requires the AI SDK. A `StepExecutor` with no model at
all is valid; the runner cannot tell the difference and does not care.

## Verdicts are ternary

`passed | failed | blocked`, plus a plain-language `summary`, an optional
`errorCode` from the closed agent code set, and optional `facts`: short values
a later step may need, quoted verbatim into the ledger as `noted` (at most
eight, 120 characters each), where they outlive the summary under compaction.

- `failed` — the application did not behave as the step required.
- `blocked` — something outside the product prevented a verdict. Blocked
  requires a blockable error code, and every blockable code names one closed
  category (`blockedCategoryOf(code)`), so a blocked step always has an
  owner:

  | Category | Owner | Codes |
  |---|---|---|
  | `credentials` | whoever holds the accounts | `AUTH_CREDENTIAL_UNAVAILABLE`, `AUTH_CREDENTIAL_INVALID` |
  | `environment` | whoever runs the environment | `ENVIRONMENT_UNAVAILABLE`, `APP_UNREACHABLE` |
  | `seed_data` | whoever seeds the data | `SEED_DATA_MISSING` |
  | `test_setup` | whoever owns the test | `TEST_SETUP_FAILED`, `APP_NOT_OPEN`, `POLICY_DENIED` |
  | `automation` | the executor ran out of room or lacks the capability | `AUTOMATION_UNSUPPORTED`, `STEP_BUDGET_EXHAUSTED`, `STEP_TIMEOUT`, `MODEL_UNAVAILABLE` |

  The table in `agent/error.ts` is the single owner: exit categories,
  `BLOCKABLE_CODES`, and the categories all derive from it.

Fail-closed invariants the runner enforces over every executor:

1. Runtime truth outranks the verdict: a step that exhausted its budget or
   deadline cannot be reported `passed` by its executor.
2. The verdict grammar is closed: unknown statuses or codes reject with
   `MODEL_OUTPUT_INVALID`; runtime codes (`STEP_TIMEOUT`,
   `STEP_BUDGET_EXHAUSTED`, `CANCELLED`) are runtime-assigned.
3. An executor that returns without concluding fails the step with
   `STEP_NO_CONCLUSION` — never a guessed success.

## Verdicts in the report

`blocked` is first-class end to end: the step record carries `status:
"blocked"`, and the run derives `status: "blocked"` when it did not pass and
*every* non-passing result carries a blockable error code — positive evidence,
never absence of it. One genuine failure keeps the run failed. Exit codes
continue to follow the error categories (configuration/infrastructure), so
CI distinguishes "the app is broken" from "the test could not run" at every
level: step, run, and process.

## The golden path: `createToolLoopExecutor`

The runner ships no agent. The `agent` config value accepts the executor
itself (or `agent.executor` beside the options), and the package ships the
chassis a project builds one on:

```ts
import { createToolLoopExecutor, defineTool } from 'e2e/agent';

export default defineConfig({
  agent: {
    model: gateway('anthropic/claude-sonnet-4-5'),   // any AI SDK LanguageModel
    executor: createToolLoopExecutor({
      name: 'my-agent',
      system: 'You are a QA agent. Verify every outcome on screen.',
      tools: (ctx, helpers) => ({ ...myGrammarTools(ctx, helpers), seedCart }),
      buildPrompt: async (ctx) => `${ctx.step.instruction}\n\n${(await ctx.observe()).text}`,
    }),
  },
});
```

A project whose config names no executor still runs deterministic tests and
the judgment tier (`assert`, `waitFor`, `extract`, which need only a model);
its first `agent.act()` fails with `INVALID_CONFIG` naming the missing
executor.

**`createToolLoopExecutor`** is the chassis: the `complete_step` verdict tool
and the closed blocked-code policy, hard stops (budget, timeout, cancel end
the loop, never the model), loop guards (a literally repeated call or a short
cycle of identical calls earns a notice, then forces the conclusion), a
wind-down notice near the turn budget and near the step clock with the final
turns offering only the verdict tool, model-call accounting, sampling at
temperature 0, and a step transcript under `--debug`. A `complete_step`
issued alongside other tool calls is discarded and the model is told why: a
verdict always follows the evidence it claims. The caller supplies the tool
vocabulary and the first prompt, and may supply `prepareMessages(messages,
turn)` — between-turn history preparation that carries forward to later turns
and may return `{ messages, stop }` to force the conclusion when the executor
has evidence the guards cannot see — and `providerOptions` sent with every
model call. A guard never invents a verdict; the model still writes its own
summary.

Under `--debug`, every planned step persists its executor transcript — turns,
tool calls, truncated results — as a step-attributed `log` artifact, so a
wandering step is diagnosed by reading, not guessing.

`defineTool(tool, { replay, mutates, secrets })` attaches required semantics
to an AI SDK tool. Undeclared semantics are not trusted: plain tools are
rejected, and the annotations are what the policy layer keys on as it grows.
`isDefinedTool` and `toolAppliesTo` are exported for executors that merge
project tools into their own vocabulary.

## Replacing the toolset wholesale

Because the socket is one interface and the chassis loop is ordinary AI SDK
code, an executor may ignore `ctx.actions` and bring an entirely different
tool source — for example, driving a real device through a toolkit that
already speaks AI SDK tools:

```ts
import { ToolLoopAgent } from 'ai';
import { createAgentDeviceTools } from 'agent-device/ai-sdk';
import type { StepExecutor } from 'e2e';

export function deviceExecutor(): StepExecutor {
  return {
    name: 'agent-device',
    version: '1',
    async runStep(ctx) {
      const { tools, client } = await createAgentDeviceTools({
        session: 'e2e-step',
        platform: 'ios',
      });
      try {
        const loop = new ToolLoopAgent({ model: myModel, tools });
        const result = await loop.generate({
          prompt: ctx.step.instruction,
          abortSignal: ctx.signal,
        });
        ctx.budgets.recordModelCall();
        return { status: 'passed', summary: result.text.slice(0, 500) };
      } finally {
        await client.sessions.close();
      }
    },
  };
}
```

This works without any change to the runner. Two honest caveats:

- Actions taken through foreign tools bypass `ctx.actions`, so the harness
  cannot police, budget, or record them; the report sees only what the
  executor reports. That is the declared-semantics gap `defineTool`
  annotations exist to close — a production integration should wrap foreign
  tools in `defineTool` and, where possible, route device actions through a
  driver so the whole safety story applies.
- Only the planned tier moves this way. `screen` and `expect` are bound to
  the configured driver; testing a different device
  end-to-end wants a driver for it (chapter 09), not just an executor.

Deriving a trustworthy verdict from free text is the executor author's
problem; the chassis solves it with an explicit `complete_step` tool,
and that pattern is recommended over parsing `result.text`.
