import { AgentError } from 'e2e';
import type { CigePlugin } from '@e2e-dev/cige';

export const shop: CigePlugin = {
  name: 'shop',
  // The one way an x- field reaches the model: a line in the case's agentContext.
  context: (testCase) => {
    const flags = testCase.context.extensions?.['x-feature-flags'];
    return Array.isArray(flags) ? `Feature flags on: ${flags.join(', ')}` : undefined;
  },
  // A guardrail check the deny rules can't express, driven by the guardrail's own x- data.
  onAction: (event, testCase) => {
    for (const guardrail of testCase.guardrails) {
      const host = guardrail.extensions?.['x-deny-host'];
      if (typeof host === 'string' && event.summary.includes(host)) return { guardrail: guardrail.id, reason: `${host} is off limits` };
    }
    return undefined;
  },
  // A step kind: { "id": "e4", "use": "order-api", "with": { "path": "/test-api/orders/{order}", "expect": 200 } }
  steps: {
    'order-api': async ({ step }) => {
      const response = await fetch(new URL(String(step.with.path), 'http://localhost:3000'));
      if (response.status !== step.with.expect) {
        throw new AgentError('ASSERTION_FAILED', `GET ${String(step.with.path)} answered ${response.status}`);
      }
    },
  },
  summarize: ({ testCase }) => ({ owner: testCase.extensions?.['x-owner'] ?? 'unowned' }),
  readiness: (testCase) => (testCase.extensions?.['x-owner'] === undefined ? ['no x-owner: nobody is paged when it fails'] : []),
};
