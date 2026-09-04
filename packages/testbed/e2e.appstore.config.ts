/**
 * Opt-in App Store readiness audit on the `@e2edev/agent-device` engine: an
 * agent tours a third-party iOS app the way App Review does and records a
 * verdict per guideline into `.e2e/appstore/findings.jsonl`, which
 * `scripts/appstore-report.mjs` turns into a readiness report. Point it at
 * an app and run:
 *
 *   AI_GATEWAY_API_KEY=... E2E_APP_PATH=build/MyApp.app pnpm --filter @e2edev/testbed test:appstore
 *   AI_GATEWAY_API_KEY=... E2E_APP=com.example.myapp pnpm --filter @e2edev/testbed test:appstore
 *
 * `E2E_APP_PATH` installs a simulator build first; `E2E_APP` names an app
 * already on the simulator by bundle id or display name. Without either the
 * suite audits Apple's Reminders as a smoke target. Requires Xcode with a
 * booted iOS simulator. Not part of CI: every check spends real model calls.
 *
 * The agent's knowledge is plain markdown under `tests-appstore/context/`:
 * `reviewer.md` (how a reviewer tours an app, how to clear system sheets) is
 * the project context every step reads; `guidelines.md` (the rubric) is
 * spread into every check's `agentContext` from `tests-appstore/audit.ts`,
 * because `extract` reads the test context and never runs through the
 * executor.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { E2EConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
import { agentDevice } from '@e2edev/agent-device';
import { agentDeviceTools } from '@e2edev/agent-device/tools';
import { createGateway } from 'ai';

const appPath = process.env.E2E_APP_PATH;
const app = process.env.E2E_APP ?? (appPath === undefined ? 'Reminders' : undefined);

const device = agentDevice({
  platform: 'ios',
  ...(app === undefined ? {} : { app }),
  ...(appPath === undefined ? {} : { appPath }),
  session: 'e2e-testbed-appstore',
});

const reviewerContext = readFileSync(fileURLToPath(new URL('./tests-appstore/context/reviewer.md', import.meta.url)), 'utf8');

export default {
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-appstore',
  tests: 'tests-appstore/**/*.e2e.ts',
  targets: [{ name: 'ios-simulator', platform: 'ios', engine: device }],
  timeout: 900_000,
  actionTimeout: 90_000,
  workers: 1,
  agent: {
    executor: createAgent({ tools: agentDeviceTools(device) }),
    model: createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '' }).languageModel(
      process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna',
    ),
    maxModelCalls: 40,
    context: `The surface is a real iOS simulator observed through its accessibility tree.\n\n${reviewerContext}`,
  },
} satisfies E2EConfig;
