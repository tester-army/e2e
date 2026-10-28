import type { E2EConfig } from 'e2e';
import { explore } from 'e2e/runner';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';

const config: E2EConfig = {
  agents: { default: { model: gateway('openai/gpt-6-luna-fast') } },
  targets: [{ name: 'web', engine: web(), app: { url: 'http://localhost:3000' } }],
};
const controller = new AbortController();
const result = await explore({
  config,
  goal: 'Explore the checkout flow like a first-time buyer and report anything off',
  maxSteps: 4,
  interruptSignal: controller.signal,
  onEvent(event) {
    if (event.type === 'explore' && event.progress.phase === 'finding') console.log(event.progress.finding.title);
  },
});

console.log(result.status, result.explore.ended, result.explore.findings.length);
