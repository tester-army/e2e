/**
 * Locate cache on a mobile target (spec 10-determinism.md, 16-mobile.md).
 *
 * The cache is not web-only, and mobile is where it is worth the most: a locate
 * that misses costs an accessibility snapshot round-trip plus a model call. It
 * is also where the key is weakest, because a mobile session exposes no URL, so
 * the route half of the screen fingerprint contributes nothing and the viewport
 * half carries the whole burden. That makes viewport stability a cache
 * correctness property, and it is asserted here rather than left to a driver
 * detail: a session that revised its viewport mid-run re-keyed every later step.
 *
 * Runs share one project directory so the second run reads what the first wrote,
 * and the model is scripted so "a hit costs zero model calls" is countable.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentDevice } from '@e2edev/agent-device';
import { createFakeDaemon, type NodeSpec } from '../helpers/fake-daemon.ts';
import { fakeCalls, installFakeModel, locateBestMatch } from '../helpers/fake-model.ts';
import { assertValidCacheEntry } from '../helpers/cache-schema.ts';
import { createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import type { E2EConfig } from '../../src/index.ts';
import type { ReportStep } from '../../src/report/build.ts';

const SCREEN: readonly NodeSpec[] = [
  {
    type: 'XCUIElementTypeApplication',
    label: 'Example',
    rect: { x: 0, y: 0, width: 402, height: 874 },
    children: [
      {
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        identifier: 'continue-cta',
        rect: { x: 20, y: 220, width: 280, height: 48 },
      },
    ],
  },
];

const SUITE = `import { test } from 'e2e';

test('taps continue', async ({ app, agent }) => {
  await app.open();
  await agent.tap('the Continue button');
});
`;

/** Runs one mobile project and reports its agent steps and locate-call count. */
async function runOnce(project: FixtureProject, options: { vision?: boolean } = {}) {
  const model = installFakeModel((call) => locateBestMatch(call));
  const daemon = createFakeDaemon({ screen: () => SCREEN });
  const outcome = await runExisting(project, {
    appUrl: '',
    config: {
      specVersion: '0.1',
      targets: [
        {
          name: 'ios',
          platform: 'ios',
          driver: agentDevice({ transport: daemon.transport }),
          app: 'com.example.app',
        },
      ],
      artifacts: [],
      reporters: ['json'],
      agent: { model, ...(options.vision === true ? { vision: true } : {}) },
    } as unknown as E2EConfig,
  });
  const report = JSON.parse(
    readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8'),
  ) as { run: { results: { attempts: { steps: ReportStep[] }[] }[] } };
  const steps = report.run.results
    .flatMap((result) => result.attempts)
    .flatMap((attempt) => attempt.steps)
    .filter((step) => step.kind === 'agent');
  return {
    steps,
    locateCalls: fakeCalls.filter((call) => call.schemaName === 'agent-locate-1').length,
    passed: outcome.status === 'passed',
  };
}

describe('locate cache on a mobile target', () => {
  it(
    'writes a schema-valid entry, then replays it without a model call',
    async () => {
      const project = createProject({ 'tests/cache.e2e.ts': SUITE });
      try {
        const cold = await runOnce(project);
        expect(cold.passed).toBe(true);
        expect(cold.locateCalls).toBe(1);
        expect(cold.steps[0]!.cache).toMatchObject({ status: 'written' });

        const entryPath = path.join(
          project.dir,
          '.e2e',
          'cache',
          `${cold.steps[0]!.cache!.keyHash}.json`,
        );
        assertValidCacheEntry(JSON.parse(readFileSync(entryPath, 'utf8')));

        const warm = await runOnce(project);
        expect(warm.passed).toBe(true);
        // The replay resolves against a live snapshot and re-verifies identity,
        // so the saving is the model call, not the device round-trip.
        expect(warm.locateCalls).toBe(0);
        expect(warm.steps[0]!.cache).toMatchObject({ status: 'hit' });
        expect(warm.steps[0]!.cache!.keyHash).toBe(cold.steps[0]!.cache!.keyHash);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'replays a tree-only entry on a run that captures pixels',
    async () => {
      // A vision run measures the device to capture pixels, and the measured
      // logical size and density both differ from the snapshot's geometry. If
      // that measurement reached the observation viewport it would change the
      // screen fingerprint, so the two runs could never share an entry: each
      // would miss, rewrite, and grow the store. The viewport is therefore
      // resolved once per session and stays in point space.
      const project = createProject({ 'tests/cache.e2e.ts': SUITE });
      try {
        const cold = await runOnce(project);
        const vision = await runOnce(project, { vision: true });

        expect(cold.passed).toBe(true);
        expect(vision.passed).toBe(true);
        expect(cold.steps[0]!.cache).toMatchObject({ status: 'written' });
        expect(vision.steps[0]!.cache).toMatchObject({ status: 'hit' });
        expect(vision.steps[0]!.cache!.keyHash).toBe(cold.steps[0]!.cache!.keyHash);
        expect(vision.locateCalls).toBe(0);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );
});
