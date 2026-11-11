import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';
import { decisionFilter } from '@e2e-dev/decision';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  filters: [decisionFilter({ model: gateway.decisionModel('typesafe-ai/jev') })],
} satisfies E2EConfig;
