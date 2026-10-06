import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { decisionExecutor } from '@e2e-dev/decision';
import { typeSafeAi } from '@ai-sdk/typesafe-ai';
import { openrouter } from '@openrouter/ai-sdk-provider';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  agents: {
    default: {
      executor: decisionExecutor({
        model: typeSafeAi.decisionModel('jev-latest'),
        textModel: openrouter('inception/mercury-2.5'),
      }),
    },
  },
} satisfies E2EConfig;
