# @e2e-dev/cige

Run [CIGE](https://www.amazon.science/publications/cige-an-agentic-ai-test-case-standard)
test cases with e2e. A CIGE case keeps the stable meaning of a test apart
from the parts that drift:

- **Context**: where the test runs.
- **Intent**: why it exists and what a pass needs.
- **Guardrails**: what the agent must never do.
- **Execution**: the first path to try.

```json title="tests/cige/checkout.cige.json"
{
  "id": "checkout-discount",
  "Context": { "system": "Shop web app", "open": "/cart", "specRef": "docs/specs/checkout.md" },
  "Intent": {
    "statement": "A shopper can check out with a valid discount code",
    "evidence": [{ "id": "order-record", "hook": "orderPersisted" }]
  },
  "Guardrails": [{ "id": "no-refund", "rule": "Never refund an order", "deny": { "actions": ["tool:refund"] } }],
  "Execution": [
    { "id": "e1", "step": "apply the discount code SAVE10" },
    { "id": "e2", "step": "pay with the test card" }
  ]
}
```

```ts
// tests/cige.e2e.ts
import { cigeSuite } from '@e2e-dev/cige';

cigeSuite('tests/cige/*.cige.json', {
  hooks: { orderPersisted: async () => (await fetch('http://localhost:3000/test-api/orders/latest')).ok },
});
```

```ts
// e2e.config.ts
import { cige } from '@e2e-dev/cige';

export default { /* targets, agents */ reporters: ['list', cige({ cases: 'tests/cige/*.cige.json' })] };
```

Each case becomes one test, tagged `cige:<id>` and titled by its Intent. It
runs each Execution step as an `agent.act` goal, with the guardrails on the
instruction. A guardrail's `deny` rule is also checked after every action,
and a match stops the step with `POLICY_DENIED`. The case passes only when
every piece of evidence the Intent names holds, and then the Intent itself.

The `cige()` reporter writes `.e2e/cige/<id>.run-summary.json`. Each summary
holds a first classification of the result (infrastructure, outdated test
logic, or product defect), the failing step's id, and pointers to the
report, the trace, `specRef`, and `buildRef`. The
[CIGE agent skills](https://github.com/vivekkrishna/agentic-validation-skills)
read it to classify a failure and repair the case.

The file format is pinned by `schema/cige-1.schema.json`. See the
[CIGE guide](https://e2e.tester.army/docs/cige) for every field, the
guardrail rules, and the classification table.
