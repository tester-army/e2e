/**
 * Opt-in device suite on the `@e2edev/agent-device` engine: two honest
 * mobile targets, an iOS simulator and an Android emulator, with no browser
 * and no app URL. Each engine opens its platform's Settings app fresh for
 * every attempt, so each test starts on the same screen and every `agent.act`
 * step stays inside the tap/type/scroll grammar the trace cache replays
 * zero-turn on the next run. Tests pick their platform with `platforms`: the
 * two Settings apps share no labels. Run manually:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:device
 *
 * Requires Xcode with a booted iOS simulator and the Android SDK with one AVD
 * (`agent-device doctor`); agent-device boots the emulator itself. Not part
 * of CI: every act step spends real model calls and real device time. One
 * device run at a time: concurrent runs would share the pinned sessions.
 */

import type { E2EConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { agentDevice } from '@e2edev/agent-device';
import { agentDeviceTools } from '@e2edev/agent-device/tools';
import { gateway } from 'ai';

const ios = agentDevice({ platform: 'ios', app: 'Settings', session: 'e2e-testbed-device-ios' });
const android = agentDevice({
  platform: 'android',
  app: 'com.android.settings',
  session: 'e2e-testbed-device-android',
});

export default {
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-device',
  tests: 'tests-device/**/*.e2e.ts',
  targets: [
    { name: 'ios-simulator', engine: ios },
    { name: 'android-emulator', engine: android },
  ],
  timeout: 300_000,
  actionTimeout: 90_000,
  workers: 1,
  agents: {
    default: {
      executor: createAgent({ tools: agentDeviceTools(ios, android) }),
      model: gateway(process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna-fast'),
      maxModelCalls: 40,
      context: [
        'The surface is a real mobile device (an iOS simulator or an Android',
        'emulator) observed through its accessibility tree; its Settings app is',
        'already open when a step starts. The device keeps its state between',
        'steps: when the right screen is already up, continue from it instead of',
        'reopening. The system may interrupt with sheets (Siri or Dictation',
        'onboarding, privacy panes, setup wizards): dismiss them and resume; a',
        'dismissible interrupt is never a reason to conclude blocked. Settings',
        'rows are named after their label; tap them to navigate, and use the back',
        'button in the top bar to return.',
      ].join(' '),
    },
  },
} satisfies E2EConfig;
