import type { E2EConfig } from 'e2e';
import { run } from 'e2e/runner';
import { web } from '@e2e-dev/web';

const config: E2EConfig = {
  targets: [{ name: 'web', engine: web(), app: { url: 'http://localhost:3000' } }],
};
const controller = new AbortController();
const result = await run({
  config,
  files: ['tests/signup.e2e.ts'],
  interruptSignal: controller.signal,
  onEvent(event) {
    if (event.type === 'test-started') console.log(event.title);
  },
});

console.log(result.status, result.report.run.summary);
