# @e2e-dev/decision

Run `agent.act` and `agent.assert` through a decision model instead of an LLM:
any AI SDK decision model that answers `choice` questions with probability
distributions (TypeSafe Jev, OpenAI `gpt-6-luna` through the bundled
`openaiDecisionModel()` or `@ai-sdk/openai` 4.0.86 or later), plus a small
language model that writes field values when the decision model picks
`type` or `upload`. Needs `ai` 7, version 7.0.128 or later.

```ts
import type { E2EConfig } from 'e2e';
import { decisionExecutor } from '@e2e-dev/decision';
import { typeSafeAi } from '@ai-sdk/typesafe-ai';
import { openrouter } from '@openrouter/ai-sdk-provider';

export default {
  agents: {
    default: {
      executor: decisionExecutor({
        model: typeSafeAi.decisionModel('jev-latest'),
        textModel: openrouter('inception/mercury-2.5'),
      }),
    },
  },
} satisfies E2EConfig;
```

Set `agents.default.executor` in the e2e config. Tests stay plain natural
language, with no params needed. One `experimental_decide` call per action
asks the operation plus one target question per operation; operations with a
single target dispatch without a question. The text model is also the agent's
judgment tier (`waitFor`, `extract`); without a text model or a configured agent
`model`, `type` is never offered.

Each turn offers every operation the engine declares: tap, type, submit,
select, check, upload, hover, right-click, double-tap, long-press, drag,
scroll-to, scroll, and back; target questions carry a `none` option. With
`vision: true` and `openaiDecisionModel()`, every question also sees a
masked screenshot, and `tap_at` over a numbered grid reaches drawn
controls. The runner authorizes every dispatched action and records every
model call against the step budget. `providerOptions` go with every decide
call and reach the decision model only; the text model keeps the agents
entry's `providerOptions`. Secrets stay declared handles filled only through
`typeSecret`; password fields never reach the text model. `minProbability`
and `minConfidence` gates are off by default. A `done`/`failed` claim passes
an independent fresh-screen check before it concludes the step.

See the [decision models guide](https://e2e.tester.army/docs/decision-models)
for setup, gates, vision, and limits (no `navigate`, the 255-choice cap).
