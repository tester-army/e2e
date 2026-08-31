# 16 — Step executors

Status: informative for `sdk-0.1` (the socket ships; conformance IDs land with
a later suite version). Canonical types: the executor section of
[api/e2e.d.ts](./api/e2e.d.ts), including `BLOCKABLE_CODES`. The `e2e/agent`
value exports (`createAgent`, `defineTool`) are package API documented in the
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
test written against `agent.act` survives moving from the built-in agent to a
hand-rolled one, to a vendor's, and back.

## The socket

```ts
interface StepExecutor {
  readonly name: string;
  readonly version?: string;
  runStep(context: StepExecutorContext): Promise<StepVerdict>;
}
```

One step in, one verdict out. The context provides:

- `step` — the instruction and JSON-safe params of one `agent.act` call.
- `observe()` — a fresh, redacted, size-bounded semantic observation.
- `actions` — the action grammar (`tap`, `type`, `press`, `select`, `scroll`,
  `navigate`), addressed by node ids from the newest observation. Every call
  is checkpointed against the deadline and the action budget, policed, and
  recorded as a step event.
- `budgets` — limits plus `recordModelCall(usage?)`, which feeds step metrics
  and model provenance in the report.
- `model` — the config-resolved AI SDK model, which an executor may ignore.
- `ledger`, `agentContext`, `signal`.

The interface never requires the AI SDK. A `StepExecutor` with no model at
all is valid; the runner cannot tell the difference and does not care.

## Verdicts are ternary

`passed | failed | blocked`, plus a plain-language `summary` and an optional
`errorCode` from the closed agent code set.

- `failed` — the application did not behave as the step required.
- `blocked` — credentials, the environment, or the executor's own budget
  prevented a *product* verdict. Blocked requires a blockable error code and
  classifies as configuration/infrastructure, not as a test failure, so exit
  codes and reports distinguish "the app is broken" from "the test could not
  run".

Fail-closed invariants the runner enforces over every executor:

1. Runtime truth outranks the verdict: a step that exhausted its budget or
   deadline cannot be reported `passed` by its executor.
2. The verdict grammar is closed: unknown statuses or codes reject with
   `MODEL_OUTPUT_INVALID`; runtime codes (`STEP_TIMEOUT`,
   `STEP_BUDGET_EXHAUSTED`, `CANCELLED`) are runtime-assigned.
3. An executor that returns without concluding fails the step with
   `STEP_NO_CONCLUSION` — never a guessed success.

## The golden path: `createAgent`

`e2e/agent` ships the built-in executor as a constructor:

```ts
import { createAgent, defineTool } from 'e2e/agent';

export default defineConfig({
  agent: {
    executor: createAgent({
      model: anthropic('claude-sonnet-4-5'),  // any AI SDK LanguageModel
      system: 'Prefer keyboard interactions.',
      tools: { seedCart },                    // defineTool values, merged in
    }),
  },
});
```

It is an AI SDK tool loop over the action grammar: mutating tools return the
updated screen, stale screen snapshots are compacted out of the transcript, a
wind-down notice fires near the turn budget, and the final turns offer only
the `complete_step` verdict tool — a wandering model produces a real verdict,
not a burned budget.

`defineTool(tool, { replay, mutates, secrets })` attaches required semantics
to an AI SDK tool. Undeclared semantics are not trusted: plain tools are
rejected, and the annotations are what the cache and policy layers key on as
they grow.

## Replacing the toolset wholesale

Because the socket is one interface and the built-in loop is ordinary AI SDK
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
- Only the planned tier moves this way. The located verbs, `screen`, and
  `expect` are bound to the configured driver; testing a different device
  end-to-end wants a driver for it (chapter 09), not just an executor.

Deriving a trustworthy verdict from free text is the executor author's
problem; the built-in loop solves it with an explicit `complete_step` tool,
and that pattern is recommended over parsing `result.text`.

## Caching

Planned steps are not cached in this release. The planned mechanism replays a
step's recorded *action-trace* zero-model and hands the step back to the
executor mid-step on divergence. It extends the `cache-1` store, keying, and
fail-closed validity rules (chapter 10) rather than adding a second cache: a
located-action entry is the one-action degenerate case of a trace entry, and
consolidation converges the two on a single mechanism.
