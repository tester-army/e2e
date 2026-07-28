/**
 * Locate cache integration coverage (spec 10-determinism.md).
 *
 * Runs the same project twice against one project directory so the second run
 * reads what the first wrote. The model is scripted, so "a hit costs zero model
 * calls" is a countable assertion rather than a timing observation.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { fakeCalls, installFakeModel, locateBestMatch, type FakeCall } from '../helpers/fake-model.ts';
import { assertValidCacheEntry } from '../helpers/cache-schema.ts';
import { createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import type { E2EConfig } from '../../src/index.ts';
import type { ReportStep } from '../../src/report/build.ts';

const SUITE = `import { test, expect } from 'e2e';

test('taps the increment button', async ({ app, agent, screen }) => {
  await app.open();
  await agent.tap('the Increment button');
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;

/** A suite whose located action is not in the cache-1 method enum. */
const UNCACHEABLE_SUITE = `import { test, expect } from 'e2e';

test('hovers the hover zone', async ({ app, agent, screen }) => {
  await app.open('/verbs');
  await agent.hover('the Hover zone');
  await expect(screen.getByRole('button', { name: 'Revealed action' })).toBeVisible();
});
`;

function respond(call: FakeCall): unknown {
  if (call.schemaName !== 'agent-locate-1') throw new Error(`unexpected ${call.schemaName}`);
  return locateBestMatch(call);
}

describe('locate cache', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  /** Runs one project and returns its agent steps plus the locate-call count. */
  async function runOnce(
    project: FixtureProject,
    config: Partial<E2EConfig> = {},
  ): Promise<{ steps: ReportStep[]; locateCalls: number; passed: boolean }> {
    const model = installFakeModel(respond);
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'],
        ...config,
        agent: { model, ...config.agent },
      },
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

  function cacheFiles(project: FixtureProject): string[] {
    const directory = path.join(project.dir, '.e2e', 'cache');
    try {
      return readdirSync(directory).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
  }

  describe('a warm cache replaces the model call', () => {
    let project: FixtureProject;
    let first: Awaited<ReturnType<typeof runOnce>>;
    let second: Awaited<ReturnType<typeof runOnce>>;

    beforeAll(async () => {
      project = createProject({ 'tests/cache.e2e.ts': SUITE });
      first = await runOnce(project);
      second = await runOnce(project);
    }, 180_000);

    afterAll(() => project?.cleanup());

    it('writes one schema-valid entry on the cold run', () => {
      expect(first.passed).toBe(true);
      expect(first.locateCalls).toBe(1);
      expect(first.steps[0]!.cache).toMatchObject({ status: 'written' });

      const files = cacheFiles(project);
      expect(files).toHaveLength(1);
      const entry = JSON.parse(
        readFileSync(path.join(project.dir, '.e2e', 'cache', files[0]!), 'utf8'),
      );
      assertValidCacheEntry(entry);
      expect(entry.kind).toBe('locate');
      expect(entry.generation).toBe(1);
      // The entry file name is the key digest, which is also how replay is
      // authorized.
      expect(files[0]).toBe(`${entry.keyHash}.json`);
    });

    it('spends zero model calls on the warm run', () => {
      expect(second.passed).toBe(true);
      expect(second.locateCalls).toBe(0);
      expect(second.steps[0]!.cache).toMatchObject({ status: 'hit' });
      expect(second.steps[0]!.metrics!.modelCalls).toBe(0);
    });

    it('reports the key hash on every non-bypassed status', () => {
      for (const step of [...first.steps, ...second.steps]) {
        expect(step.cache!.keyHash).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(second.steps[0]!.cache!.keyHash).toBe(first.steps[0]!.cache!.keyHash);
    });

    it('stores a semantic locator and no node reference or selector', () => {
      const raw = readFileSync(
        path.join(project.dir, '.e2e', 'cache', cacheFiles(project)[0]!),
        'utf8',
      );
      expect(raw).not.toContain('web-selector');
      expect(raw).not.toContain('"ref"');
      expect(raw).not.toContain('revision');
      expect(JSON.parse(raw).payload.locator.kind).toBe('query');
      expect(JSON.parse(raw).payload.expected).toMatchObject({ role: 'button' });
    });

    it('still performs the real action on a hit', () => {
      // The suite asserts the counter reached 1, so a hit that skipped the tap
      // would have failed the run.
      expect(second.passed).toBe(true);
    });
  });

  describe('the cache is never authority', () => {
    let project: FixtureProject;

    beforeAll(() => {
      project = createProject({ 'tests/cache.e2e.ts': SUITE });
    });

    afterAll(() => project?.cleanup());

    it('falls back to the model when an entry is poisoned', async () => {
      const cold = await runOnce(project);
      expect(cold.steps[0]!.cache!.status).toBe('written');

      const file = path.join(project.dir, '.e2e', 'cache', cacheFiles(project)[0]!);
      writeFileSync(file, '{"schemaVersion":"cache-1","kind":"locate"', 'utf8');

      const poisoned = await runOnce(project);
      expect(poisoned.passed).toBe(true);
      expect(poisoned.locateCalls).toBe(1);
      const step = poisoned.steps[0]!;
      // The poisoned entry was ignored and replaced, and the rejection is
      // visible as a denied policy event on the step.
      expect(step.cache!.status).toBe('written');
      expect(step.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'policy', name: 'cache.entry', decision: 'denied' }),
        ]),
      );
    }, 180_000);

    it('misses when the stored locator no longer resolves', async () => {
      const file = path.join(project.dir, '.e2e', 'cache', cacheFiles(project)[0]!);
      const entry = JSON.parse(readFileSync(file, 'utf8'));
      entry.payload.locator.query.name = { kind: 'string', value: 'Nonexistent', exact: true };
      entry.payload.expected = { role: 'button', name: 'Nonexistent' };
      writeFileSync(file, JSON.stringify(entry, null, 2), 'utf8');

      const stale = await runOnce(project);
      expect(stale.passed).toBe(true);
      expect(stale.locateCalls).toBe(1);
      expect(stale.steps[0]!.cache!.status).toBe('written');
    }, 180_000);
  });

  describe('cache modes', () => {
    it('writes nothing and never hits when the mode is off', async () => {
      const project = createProject({ 'tests/cache.e2e.ts': SUITE });
      try {
        const first = await runOnce(project, { agent: { cache: 'off' } });
        const second = await runOnce(project, { agent: { cache: 'off' } });
        expect(cacheFiles(project)).toEqual([]);
        expect(first.locateCalls).toBe(1);
        expect(second.locateCalls).toBe(1);
        expect(second.steps[0]!.cache).toEqual({ status: 'bypassed' });
      } finally {
        project.cleanup();
      }
    }, 180_000);

    it('reads but never writes when the mode is read-only', async () => {
      const project = createProject({ 'tests/cache.e2e.ts': SUITE });
      try {
        const cold = await runOnce(project, { agent: { cache: 'read-only' } });
        expect(cold.locateCalls).toBe(1);
        expect(cacheFiles(project)).toEqual([]);
        expect(cold.steps[0]!.cache!.status).toBe('miss');

        // Warm the cache with a read-write run, then prove read-only replays it.
        await runOnce(project, { agent: { cache: 'read-write' } });
        const warm = await runOnce(project, { agent: { cache: 'read-only' } });
        expect(warm.locateCalls).toBe(0);
        expect(warm.steps[0]!.cache!.status).toBe('hit');
      } finally {
        project.cleanup();
      }
    }, 240_000);
  });

  /** One web target whose only varying property is its viewport. */
  function target(width: number, height: number) {
    return { name: 'chromium', platform: 'web' as const, viewport: { width, height } };
  }

  describe('key sensitivity', () => {
    it('misses when the starting screen fingerprint changes', async () => {
      const project = createProject({ 'tests/cache.e2e.ts': SUITE });
      try {
        const cold = await runOnce(project, { targets: [target(1280, 720)] });
        expect(cold.steps[0]!.cache!.status).toBe('written');

        // Only the viewport changes. It is not a key field on its own, so a
        // miss here proves the screen fingerprint is part of the identity.
        const resized = await runOnce(project, { targets: [target(900, 600)] });
        expect(resized.locateCalls).toBe(1);
        expect(resized.steps[0]!.cache!.keyHash).not.toBe(cold.steps[0]!.cache!.keyHash);

        // The original viewport still hits, so both entries coexist by key.
        const original = await runOnce(project, { targets: [target(1280, 720)] });
        expect(original.locateCalls).toBe(0);
        expect(original.steps[0]!.cache!.status).toBe('hit');
        expect(cacheFiles(project)).toHaveLength(2);
      } finally {
        project.cleanup();
      }
    }, 240_000);

    it('bypasses the cache on a retry attempt', async () => {
      const project = createProject({
        'tests/retry.e2e.ts': `import { test, expect } from 'e2e';

test('taps then fails', async ({ app, agent, screen }) => {
  await app.open();
  await agent.tap('the Increment button');
  await expect(screen.getByRole('status')).toHaveText('99');
});
`,
      });
      try {
        const outcome = await runOnce(project, { retries: 1 });
        expect(outcome.passed).toBe(false);
        const agentSteps = outcome.steps.filter((step) => step.api === 'agent.tap');
        expect(agentSteps).toHaveLength(2);
        // The first attempt caches; the retry starts from clean state and does
        // not consult the cache at all.
        expect(agentSteps[0]!.cache!.status).toBe('written');
        expect(agentSteps[1]!.cache).toEqual({ status: 'bypassed' });
      } finally {
        project.cleanup();
      }
    }, 240_000);

    it('honors a per-call cache opt-out', async () => {
      const project = createProject({
        'tests/optout.e2e.ts': `import { test, expect } from 'e2e';

test('opts out of the cache', async ({ app, agent, screen }) => {
  await app.open();
  await agent.tap('the Increment button', { cache: false });
  await expect(screen.getByRole('status')).toHaveText('1');
});
`,
      });
      try {
        const first = await runOnce(project);
        const second = await runOnce(project);
        expect(first.steps[0]!.cache).toEqual({ status: 'bypassed' });
        expect(second.locateCalls).toBe(1);
        expect(cacheFiles(project)).toEqual([]);
      } finally {
        project.cleanup();
      }
    }, 240_000);
  });

  describe('every cacheable verb replays', () => {
    let project: FixtureProject;
    let first: Awaited<ReturnType<typeof runOnce>>;
    let second: Awaited<ReturnType<typeof runOnce>>;

    beforeAll(async () => {
      project = createProject({
        'tests/verbs.e2e.ts': `import { test, expect } from 'e2e';

test('drives every cacheable verb', async ({ app, agent, screen }) => {
  await app.open();
  await agent.tap('the Increment button');
  await agent.click('the Increment button');
  await expect(screen.getByRole('status')).toHaveText('2');
  await agent.type('the Email field', 'user@example.test');
  await expect(screen.getByLabel('Email')).toHaveValue('user@example.test');
  await agent.longPress('the Menu button', { durationMs: 150 });
  await agent.scroll({ direction: 'down', within: 'the scrollable list' });
  await agent.scrollTo('the Item Gamma list item');
});
`,
      });
      first = await runOnce(project);
      second = await runOnce(project);
    }, 300_000);

    afterAll(() => project?.cleanup());

    it('caches each call under its own key', () => {
      expect(first.passed).toBe(true);
      const cached = first.steps.filter((step) => step.cache!.status === 'written');
      expect(cached.length).toBe(6);
      expect(cacheFiles(project)).toHaveLength(6);
      // Two identical instructions under different methods and call indexes
      // must not collide.
      expect(new Set(first.steps.map((step) => step.cache!.keyHash)).size).toBe(
        first.steps.length,
      );
    });

    it('replays all of them with no model calls at all', () => {
      expect(second.passed).toBe(true);
      expect(second.locateCalls).toBe(0);
      for (const step of second.steps) {
        expect(step.cache!.status).toBe('hit');
        expect(step.metrics!.modelCalls).toBe(0);
      }
    });
  });

  describe('non-cacheable calls', () => {
    it('bypasses a located action outside the cache-1 method enum', async () => {
      const project = createProject({ 'tests/hover.e2e.ts': UNCACHEABLE_SUITE });
      try {
        const outcome = await runOnce(project);
        expect(outcome.passed).toBe(true);
        expect(outcome.steps[0]!.cache).toEqual({ status: 'bypassed' });
        expect(cacheFiles(project)).toEqual([]);
      } finally {
        project.cleanup();
      }
    }, 180_000);
  });
});
