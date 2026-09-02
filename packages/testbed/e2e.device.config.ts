/**
 * Opt-in device suite on the `@e2edev/agent-device` backend: an honest iOS
 * target with no browser and no app URL. Settings is opened fresh for every
 * attempt by the backend, so each test starts on the same screen and every
 * `agent.act` step stays inside the tap/type/scroll grammar the trace cache
 * replays zero-turn on the next run. Run manually:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:device
 *
 * Requires Xcode with a booted iOS simulator (`agent-device doctor`). Not part
 * of CI: every act step spends real model calls and real simulator time. One
 * device run at a time: concurrent runs would share the pinned session.
 */

import { defineConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { agentDevice } from '@e2edev/agent-device';
import { agentDeviceTools } from '@e2edev/agent-device/tools';
import { createGateway } from 'ai';

const device = agentDevice({ platform: 'ios', app: 'Settings', session: 'e2e-testbed-device' });

export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-device',
  tests: 'tests-device/**/*.e2e.ts',
  targets: [{ name: 'ios-simulator', platform: 'ios', backend: device }],
  timeout: 300_000,
  actionTimeout: 90_000,
  workers: 1,
  agent: {
    executor: createAgent({ tools: agentDeviceTools(device) }),
    model: createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '' }).languageModel(
      process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna',
    ),
    maxModelCalls: 40,
    context: [
      'The surface is a real iOS simulator observed through its accessibility',
      'tree; the Settings app is already open when a step starts. The device',
      'keeps its state between steps: when the right screen is already up,',
      'continue from it instead of reopening. iOS may interrupt with system',
      'sheets (Siri or Dictation onboarding, privacy panes): dismiss them and',
      'resume; a dismissible interrupt is never a reason to conclude blocked.',
      'Rows in Settings are buttons named after their label; tap them to',
      'navigate, and use the back button in the navigation bar to return.',
    ].join(' '),
  },
});
