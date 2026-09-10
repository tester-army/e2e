import type { E2EConfig } from '@e2edev/e2e';
import agentConfig from './e2e.agent.config.ts';

/**
 * The agent config plus the deterministic suite, for watching the list
 * reporter interleave agent steps with plain tests. Needs the same
 * `AI_GATEWAY_API_KEY` as `test:agent`; never part of CI.
 */
export default {
  ...agentConfig,
  projectId: 'dev.e2e.testbed-mixed',
  tests: ['tests/**/*.e2e.ts', 'tests-agent/**/*.e2e.ts'],
} satisfies E2EConfig;
