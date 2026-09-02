/**
 * Opt-in device suite on the RFC0002 backend contract: an honest iOS target
 * with no driver, no browser, and no placeholder app URL. The stock
 * createAgent brain runs over the agent-device backend; deterministic device
 * management (network, permissions, location) is the contributed `device`
 * fixture. Run manually:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:device
 *
 * Requires Xcode with an iOS simulator runtime. Not part of CI: every act
 * step spends real model calls and real simulator time. One device run at a
 * time: concurrent runs would share the pinned agent-device session.
 */

import { defineConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { createGateway } from 'ai';
import { agentDevice, type Device } from './fixtures/agent-device.ts';

const { backend, tools } = agentDevice({ session: 'e2e-testbed-device', platform: 'ios' });

// The backend contributes `device`; the test API learns it through the seam
// spec 02 reserves for exactly this.
declare module 'e2e' {
  interface TestFixtures {
    device: Device;
  }
}

export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-device',
  tests: 'tests-device/**/*.e2e.ts',
  targets: [{ name: 'ios-simulator', platform: 'ios', backend }],
  timeout: 300_000,
  actionTimeout: 90_000,
  workers: 1,
  cache: 'off',
  agent: {
    executor: createAgent({ tools }),
    model: createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '' }).languageModel(
      process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna',
    ),
    maxModelCalls: 40,
    context: [
      'The surface is a real iOS simulator observed through its accessibility',
      'tree. The device keeps its state between steps: when the right app and',
      'screen are already up, continue from them instead of reopening. iOS may',
      'interrupt with system sheets (Siri or Dictation onboarding, privacy',
      'panes): dismiss them and resume; a dismissible interrupt is never a',
      'reason to conclude blocked. press/select/navigate are not available on',
      'this surface; use tap, type, scroll, and the open/back/swipe tools.',
    ].join(' '),
  },
});
