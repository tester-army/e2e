/**
 * Opt-in device suite on the RFC0002 backend contract: an honest iOS target
 * with no driver, no browser, and no placeholder app URL. The stock
 * createAgent brain runs over the agent-device backend; everything beyond the
 * grammar is an agent tool from the same factory. Run manually:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:device
 *
 * Requires Xcode with an iOS simulator runtime. Not part of CI: every step
 * spends real model calls and real simulator time. One device run at a time:
 * concurrent runs would share the pinned agent-device session.
 */

import { defineConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { createGateway } from 'ai';
import { agentDevice } from './fixtures/agent-device.ts';

const { backend, tools } = agentDevice({ session: 'e2e-testbed-device', platform: 'ios' });

export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-device',
  tests: 'tests-device/**/*.e2e.ts',
  targets: [{ name: 'ios-simulator', platform: 'ios', backend }],
  // Each step is model round trips plus real XCTest actions on the simulator;
  // latency is not a product defect, so give the budgets room.
  timeout: 300_000,
  actionTimeout: 90_000,
  workers: 1,
  // Grammar verbs on a backend are replayable in principle; turning the trace
  // cache on for device flows is its own experiment (RFC0002 migration 4).
  cache: 'off',
  agent: {
    executor: createAgent({ tools }),
    // Not the flash tier: Gemini's forced-function mode rejects large tool
    // vocabularies (each tool alone passes), so the device suite pins a model
    // that accepts them.
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
