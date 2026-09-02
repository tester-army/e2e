/**
 * Backend targets (RFC0002): a driver-less target whose surface is a
 * defineBackend body. Covers the full pipeline — config, worker, adapter,
 * executor socket, lifecycle, capability gating, and the report — with a toy
 * in-memory backend and a hand-rolled executor, no model and no browser.
 */

import { describe, expect, it } from 'vitest';
import { defineBackend } from '../../src/backend/index.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import type { SemanticNode } from '../../src/driver/index.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject } from '../helpers/run-project.ts';

const builtRunnerModule = new URL('../../dist/run/runner.js', import.meta.url).href;
const { run } = (await import(builtRunnerModule)) as typeof import('../../src/run/runner.ts');

const SUITE = `import { test } from 'e2e';

test('agent drives the toy device', async ({ agent }) => {
  await agent.act('increment the counter to 2');
});
`;

const SCREEN_SUITE = `import { test, expect } from 'e2e';

test('screen is unavailable on a backend without location', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('button')).toBeVisible();
});
`;

/** A two-node screen: a counter value and a button that increments it. */
function toyBackend() {
  const lifecycle: string[] = [];
  let count = 0;
  const nodes = (): SemanticNode[] => [
    { ref: { id: 'counter', revision: '' }, role: 'status', name: 'count', value: String(count) },
    { ref: { id: 'increment', revision: '' }, role: 'button', name: 'Increment' },
  ];
  const backend = defineBackend({
    name: 'toy-device',
    spiVersion: 1,
    async init() {
      lifecycle.push('init');
    },
    async dispose() {
      lifecycle.push('dispose');
    },
    async observe() {
      return { nodes: nodes() };
    },
    actions: {
      async tap(target) {
        if (target.ref.id !== 'increment') throw new Error(`no such node ${target.ref.id}`);
        count += 1;
      },
    },
  });
  return { backend, lifecycle, current: () => count };
}

/** Observes, taps until the counter reads the goal, verifies, concludes. */
const tapper: StepExecutor = {
  name: 'toy-tapper',
  version: '1',
  async runStep(context) {
    for (let round = 0; round < 5; round += 1) {
      const observation = await context.observe();
      const match = /#counter status "count" value="(\d+)"/.exec(observation.text) ??
        /value="(\d+)"/.exec(observation.text);
      const value = Number(match?.[1] ?? Number.NaN);
      if (value === 2) {
        return { status: 'passed', summary: `counter reached 2 after ${round} taps` };
      }
      await context.actions.tap({ id: 'increment' });
    }
    return { status: 'failed', summary: 'counter never reached 2' };
  },
};

describe('backend targets', () => {
  it('runs an agent step over the adapter, with lifecycle and honest provenance', async () => {
    const toy = toyBackend();
    const project = createProject({ 'tests/toy.e2e.ts': SUITE });
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', backend: toy.backend }],
          agent: { executor: tapper, maxModelCalls: 10 },
          cache: 'off',
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
      });
      expect(outcome.exitCode).toBe(0);
      expect(toy.current()).toBe(2);
      expect(toy.lifecycle).toEqual(['init', 'dispose']);
      const reportTarget = outcome.report.run.targets.find((entry) => entry.id === 'toy-sim');
      expect(reportTarget?.driver.id).toBe('backend:toy-device');
      expect(reportTarget?.platform).toBe('ios');
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('fails a screen test loud with UNSUPPORTED_CAPABILITY', async () => {
    const toy = toyBackend();
    const project = createProject({ 'tests/screen.e2e.ts': SCREEN_SUITE });
    try {
      const outcome = await run({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'toy-sim', platform: 'ios', backend: toy.backend }],
          agent: { executor: tapper },
          cache: 'off',
        },
        env: { ...process.env, APP_URL: '', CI: '' },
        quiet: true,
      });
      expect(outcome.exitCode).not.toBe(0);
      const result = outcome.results[0];
      const message = result?.attempts.at(-1)?.error?.message ?? '';
      expect(message).toMatch(/no backend capability|UNSUPPORTED/i);
    } finally {
      project.cleanup();
    }
  });
});
