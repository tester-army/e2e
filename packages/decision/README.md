# @e2e-dev/decision

Run `agent.act` and `agent.assert` through a decision model instead of an
LLM. Any AI SDK decision model that answers `choice` questions with
probability distributions works, such as TypeSafe Jev or OpenAI `gpt-6-luna`
through `@ai-sdk/openai` 4.0.90 or later. A small language model writes
field values and upload paths. Needs `ai` 7.0.134 or later.

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

Tests stay plain natural language, with no params. Each turn asks the
operation, then the target for it. Every operation the engine declares is
offered, and every target question carries a `none` option. With
`vision: true` and a model that takes images, such as
`openai.decisionModel('gpt-6-luna')`, verdicts see a masked screenshot and
`tap_at` reaches a drawn control. The runner authorizes every action and
records every model call against the step budget. Secrets stay declared
handles that only `typeSecret` fills.

See the [decision models guide](https://e2e.tester.army/docs/decision-models)
for setup, vision, gates, provider options, and limits.
