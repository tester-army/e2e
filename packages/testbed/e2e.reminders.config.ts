/**
 * Opt-in Reminders stress suite on the `@e2edev/agent-device` engine: long
 * agentic sessions against a real iOS app with real data entry, completion,
 * swipe-to-delete, and list management. Reminders is relaunched fresh for
 * every attempt; its data persists on the simulator, so every test leaves
 * the list the way it found it. Run manually:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:reminders
 *
 * Requires Xcode with a booted iOS simulator. Not part of CI: each test spends
 * dozens of model calls and minutes of simulator time.
 */

import type { E2EConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
import { agentDevice } from '@e2edev/agent-device';
import { agentDeviceTools } from '@e2edev/agent-device/tools';
import { createGateway } from 'ai';

const device = agentDevice({ platform: 'ios', app: 'Reminders', session: 'e2e-testbed-reminders' });

export default {
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-reminders',
  tests: 'tests-reminders/**/*.e2e.ts',
  targets: [{ name: 'ios-simulator', engine: device }],
  timeout: 900_000,
  actionTimeout: 90_000,
  workers: 1,
  agent: {
    executor: createAgent({ tools: agentDeviceTools(device) }),
    model: createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '' }).languageModel(
      process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna',
    ),
    maxModelCalls: 60,
    context: [
      'The surface is a real iOS simulator observed through its accessibility',
      'tree; the Reminders app is already open when a step starts. The device',
      'keeps its state between steps: continue from the screen that is up.',
      'iOS may interrupt with system sheets (Siri or Dictation onboarding,',
      'privacy panes): dismiss them and resume; a dismissible interrupt is',
      'never a reason to conclude blocked.',
    ].join(' '),
  },
} satisfies E2EConfig;
