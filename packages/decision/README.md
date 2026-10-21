# @e2e-dev/decision

Run `agent.act` and `agent.assert` through a decision model instead of an
LLM. Any AI SDK decision model that answers `choice` questions with
probability distributions works, such as TypeSafe Jev or OpenAI `gpt-6-luna`
through `@ai-sdk/openai` 4.0.90 or later. A small language model writes
field values and upload paths. Needs `ai` 7.0.134 or later. An answer with
no distribution, as a gateway fallback to a language model returns, counts
as a committed choice with probability 1 and confidence 0.

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
`typeSafeAi.decisionModel('jev-latest')` with `@ai-sdk/typesafe-ai` 3.0.19
or later, verdicts see a masked screenshot and
`tap_at` and `type_at` reach a drawn control or field. The runner authorizes every action and
records every model call against the step budget. Secrets stay declared
handles that only `typeSecret` fills.

See the [decision models guide](https://e2e.tester.army/docs/decision-models)
for setup, vision, gates, provider options, and limits.

## Test filter

With `e2e run --changed-since <ref>`, `decisionFilter()` asks a decision
model whether the change since that ref can affect each test, and leaves
out the unlikely ones:

```ts
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';
import { decisionFilter } from '@e2e-dev/decision';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  filters: [decisionFilter({ model: gateway.decisionModel('typesafe-ai/jev') })],
} satisfies E2EConfig;
```

The model must answer `boolean` questions. See
[Test filters](https://e2e.tester.army/docs/filters) for CI setup.
