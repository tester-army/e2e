/**
 * Opt-in device suite: `agent.act()` on the agent-device executor against the
 * iOS simulator's built-in Settings app. Run manually:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:device
 *
 * Requires Xcode with an iOS simulator runtime; agent-device boots a
 * simulator on the first step. Not part of CI: every step spends real model
 * calls and real simulator time. `E2E_MODEL` overrides the pinned model.
 *
 * The web target below is only the config-required host. Tests never open the
 * app, so the driver session is never touched (the dogfood-brain pattern);
 * every observation and action runs through agent-device instead.
 */

import { defineConfig } from 'e2e';
import { createGateway, registerTelemetry } from 'ai';
import { DevToolsTelemetry } from '@ai-sdk/devtools';
import { createAgentDeviceExecutor } from './fixtures/agent-device.ts';

// Every model call in this suite lands in .devtools/generations.json, one run
// per step; analyze with `npx unbox-ai runs .devtools/generations.json`, even
// mid-run. Workers re-resolve this module, so each worker registers its own.
registerTelemetry(DevToolsTelemetry());

export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-device',
  app: { url: 'http://127.0.0.1:4272' },
  tests: 'tests-device/**/*.e2e.ts',
  // No iOS driver exists yet, so a placeholder web target satisfies config
  // validation; its session is never opened. The name is what run output
  // shows, so it names the real surface under test.
  targets: [{ name: 'ios-simulator', platform: 'web', browser: 'chromium' }],
  // Each step is model round trips plus real XCTest actions on the simulator;
  // latency is not a product defect, so give the budgets room.
  timeout: 300_000,
  actionTimeout: 90_000,
  // One simulator, one pinned agent-device session: parallel workers would
  // interleave taps on the same screen.
  workers: 1,
  // Every device action is an executor tool call, which trace-1 records as a
  // non-replayable gap: a device trace can never zero-turn replay, so
  // recording would only write dead entries.
  cache: 'off',
  agent: createAgentDeviceExecutor({
    // One fixed, reusable session: agent-device sessions are named and
    // outlive the run on purpose. Do not start two device runs at once; they
    // would share this session and interleave taps on the same simulator.
    session: 'e2e-testbed-device',
    platform: 'ios',
    // Not the flash tier: Gemini's forced-function mode rejects the full
    // 16-tool agent-device vocabulary (each tool passes alone), so the device
    // suite pins a model that accepts it.
    model: createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '' }).languageModel(
      process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna',
    ),
  }),
});
