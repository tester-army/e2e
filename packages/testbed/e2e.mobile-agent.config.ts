import { createOpenAI } from '@ai-sdk/openai';
import { defineConfig } from 'e2e';
import { agentDevice } from '@e2edev/agent-device';

/**
 * Opt-in agentic mobile suite against the built-in iOS Settings app:
 *
 *   E2E_MODEL_API_KEY=... pnpm --filter @e2edev/testbed test:mobile-agent
 *
 * Not part of CI: it needs a simulator and spends real model calls.
 */
export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-mobile-agent',
  tests: 'tests-mobile-agent/**/*.e2e.ts',
  targets: [
    {
      name: 'ios',
      platform: 'ios',
      driver: agentDevice({ reset: 'relaunch' }),
      app: 'com.apple.Preferences',
      device: process.env.E2E_IOS_DEVICE ?? 'iPhone 17',
    },
  ],
  workers: 1,
  // Every located action pairs a model round trip with an XCTest snapshot.
  timeout: 600_000,
  actionTimeout: 180_000,
  assertionTimeout: 30_000,
  launchTimeout: 180_000,
  artifacts: ['screenshot'],
  reporters: ['list'],
  agent: {
    // A provider instance rather than a gateway reference, so a plain
    // OPENAI_API_KEY is enough to run this locally.
    model: createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(
      process.env.E2E_MODEL ?? 'gpt-4.1-mini',
    ),
    context: [
      'This is the iOS Settings app on a simulator, showing a list of',
      'settings rows such as General, Accessibility, and Camera.',
    ].join(' '),
  },
});
