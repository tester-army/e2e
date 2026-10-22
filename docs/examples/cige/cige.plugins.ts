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
      const path = String(step.with.path);
      let response: Response;
      try {
        response = await fetch(new URL(path, 'http://localhost:3000'));
      } catch (cause) {
        // A backend that isn't there is the environment, not the product or the path.
        throw new AgentError('ENVIRONMENT_UNAVAILABLE', `GET ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (response.status >= 500) throw new AgentError('ENVIRONMENT_UNAVAILABLE', `GET ${path} answered ${response.status}`);
      if (response.status !== step.with.expect) throw new AgentError('ASSERTION_FAILED', `GET ${path} answered ${response.status}`);
    },
  },
  summarize: ({ testCase }) => ({ owner: testCase.extensions?.['x-owner'] ?? 'unowned' }),
  readiness: (testCase) => (testCase.extensions?.['x-owner'] === undefined ? ['no x-owner: nobody is paged when it fails'] : []),
};
