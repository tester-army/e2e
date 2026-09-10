/** The real tool pack and harness, driven by a fake device and a scripted model. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createAgent } from '@e2edev/e2e/agent';
import { buildEngine } from '../../src/engine.ts';
import { AgentDeviceSurface } from '../../src/surface.ts';
import { agentDeviceTools } from '../../src/tools.ts';
import { createFakeClient, SETTINGS_SNAPSHOT } from '../helpers/fake-client.ts';

// The runner is internal to @e2edev/e2e; the test drives the built one the way
// the core package's own integration tests do. The specifier is a file URL so
// neither the bundler root nor the typechecker resolves it before a build.
const builtRunnerModule = new URL('../../../e2e/dist/run/runner.js', import.meta.url).href;
const { run } = (await import(builtRunnerModule)) as {
  run: (options: object) => Promise<{ status: string }>;
};

it('withholds a device screenshot after a secret fill without capturing pixels', async () => {
  const root = fileURLToPath(new URL('../../../e2e/tests/tmp-projects/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const project = mkdtempSync(path.join(root, 'tool-pixels-'));
  writeFileSync(path.join(project, 'test.e2e.ts'), `import { test, credentials } from '@e2edev/e2e';
    test('withhold pixels', async ({ screen, agent }) => {
      await screen.getByRole('textbox', { name: 'Password' }).fill(credentials.user('audit').password);
      await agent.act('inspect the pixels');
    });`);
  const fake = createFakeClient({ 'capture.snapshot': () => SETTINGS_SNAPSHOT });
  const engine = buildEngine(new AgentDeviceSurface({ platform: 'ios' }, () => fake.client));
  let turn = 0;
  let seenToolResult = '';
  const model = {
    specificationVersion: 'v4' as const, provider: 'test', modelId: 'scripted', supportedUrls: {},
    doStream: async () => { throw new Error('unused'); },
    doGenerate: async (options: { prompt: readonly { role: string; content: unknown }[] }) => {
      turn += 1;
      seenToolResult = JSON.stringify(options.prompt.filter((message) => message.role === 'tool'));
      return {
        content: [{ type: 'tool-call', toolCallId: `call-${turn}`, toolName: turn === 1 ? 'screenshot' : 'complete_step',
          input: JSON.stringify(turn === 1 ? {} : { status: 'passed', summary: 'pixels withheld' }) }],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [],
      };
    },
  };
  try {
    const outcome = await run({ cwd: project, quiet: true, env: {}, rawConfig: {
      tests: '*.e2e.ts', targets: [{ name: 'ios', platform: 'ios', engine }], cache: 'off',
      artifacts: [],
      credentials: { audit: { username: 'audit', password: () => 'synthetic-device-secret' } },
      agents: { default: { executor: createAgent({ tools: agentDeviceTools(engine) }), model } },
    } });
    expect(outcome.status).toBe('passed');
    expect(seenToolResult).toContain('PIXEL_TAINTED');
    expect(fake.methods()).not.toContain('capture.screenshot');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
