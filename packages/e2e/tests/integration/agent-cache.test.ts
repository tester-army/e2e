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
import { assertValidReport } from '../helpers/report-schema.ts';
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

  /** Runs one project and returns its report, agent steps, and locate-call count. */
  async function runOnce(
    project: FixtureProject,
    config: Partial<E2EConfig> = {},
  ): Promise<{
    report: unknown;
    steps: ReportStep[];
    locateCalls: number;
    passed: boolean;
  }> {
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
      report,
      steps,
      locateCalls: fakeCalls.filter((call) => call.schemaName === 'agent-locate-1').length,
      passed: outcome.status === 'passed',
    };
  }

  /** Runs a project whose model reports every target as positional. */
  async function runPositional(
    project: FixtureProject,
  ): Promise<Awaited<ReturnType<typeof runOnce>>> {
    const model = installFakeModel((call) => locateBestMatch(call, true));
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', reporters: ['json'], agent: { model } },
    });
    const report = JSON.parse(
      readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8'),
    ) as { run: { results: { attempts: { steps: ReportStep[] }[] }[] } };
    const steps = report.run.results
      .flatMap((result) => result.attempts)
      .flatMap((attempt) => attempt.steps)
      .filter((step) => step.kind === 'agent');
    return {
      report,
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
      // The entry carries only what replay consumes. It does not repeat its own
      // key: the file name is the key digest, and the runner only ever opens the
      // digest of the key it just computed.
      expect(Object.keys(entry).toSorted()).toEqual([
        'createdAt',
        'kind',
        'payload',
        'schemaVersion',
      ]);
      expect(files[0]).toBe(`${first.steps[0]!.cache!.keyHash}.json`);
    });

    it('keeps debug-only diagnostics out of the report', () => {
      // `reason` explains a status to `--debug`, but spec/schema/report-v1
      // closes the cache object. A leak here is a schema violation for every
      // consumer, so both halves are pinned: the schema, and the exact key.
      for (const run of [first, second]) {
        assertValidReport(run.report);
        for (const step of run.steps) {
          if (step.cache === undefined) continue;
          expect(Object.keys(step.cache)).not.toContain('reason');
        }
      }
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

    it('stores a semantic locator and an identity, never a node reference', () => {
      const raw = readFileSync(
        path.join(project.dir, '.e2e', 'cache', cacheFiles(project)[0]!),
        'utf8',
      );
      // A reference is bound to one observation revision, so it could only ever
      // resolve during the run that recorded it.
      expect(raw).not.toContain('"ref"');
      expect(raw).not.toContain('revision');
      const payload = JSON.parse(raw).payload;
      // A node a query addresses is stored as that query: it says what the node
      // is, so DOM churn around it does not invalidate the entry.
      expect(payload.locator.kind).toBe('query');
      expect(raw).not.toContain('web-selector');
      expect(payload.expected).toMatchObject({ role: 'button' });
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
      entry.payload.locator = { kind: 'web-selector', selector: 'html > body > #gone' };
      writeFileSync(file, JSON.stringify(entry, null, 2), 'utf8');

      const stale = await runOnce(project);
      expect(stale.passed).toBe(true);
      expect(stale.locateCalls).toBe(1);
      expect(stale.steps[0]!.cache!.status).toBe('written');
    }, 180_000);

    it('hits when only the letter case of the name changed', async () => {
      // A label the app renders "INCREMENT" one run and "Increment" the next is
      // the same control. Comparing case made every run reject the previous
      // run's entry and rewrite it, so the step never replayed once.
      const file = path.join(project.dir, '.e2e', 'cache', cacheFiles(project)[0]!);
      const entry = JSON.parse(readFileSync(file, 'utf8'));
      entry.payload.expected.name = 'INCREMENT';
      writeFileSync(file, JSON.stringify(entry, null, 2), 'utf8');

      const recased = await runOnce(project);
      expect(recased.passed).toBe(true);
      expect(recased.locateCalls).toBe(0);
      expect(recased.steps[0]!.cache!.status).toBe('hit');
    }, 180_000);

    it('misses when the stored locator resolves a different node', async () => {
      // The guard that makes an optimistic selector safe: the element at that
      // path is not the one that was recorded, so the entry is not used.
      const file = path.join(project.dir, '.e2e', 'cache', cacheFiles(project)[0]!);
      const entry = JSON.parse(readFileSync(file, 'utf8'));
      // #menu is a real button on the page, so the selector resolves; it is
      // simply not the Increment button the entry recorded.
      entry.payload.locator = { kind: 'web-selector', selector: '#menu' };
      writeFileSync(file, JSON.stringify(entry, null, 2), 'utf8');

      const wrongNode = await runOnce(project);
      expect(wrongNode.passed).toBe(true);
      expect(wrongNode.locateCalls).toBe(1);
      expect(wrongNode.steps[0]!.cache!.status).toBe('written');
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

    it('survives a conditional step that only runs on some sessions', async () => {
      // The shape every real site forces: an optional consent dialog handled in
      // a try/catch. Whether it appears must not renumber the calls after it,
      // or a production suite can never warm up at all.
      // The prelude is a located action that is not cacheable, and that leaves
      // the semantic screen unchanged: it only moves focus, which the
      // fingerprint deliberately excludes. So the only thing that can differ
      // between the two runs is how the call after it gets numbered.
      const suite = (consent: boolean) => `import { test, expect } from 'e2e';

test('taps the increment button', async ({ app, agent, screen }) => {
  await app.open();
${consent ? `  await agent.press('the Email input', 'Escape');
` : ''}  await agent.tap('the Increment button');
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;
      const project = createProject({ 'tests/conditional.e2e.ts': suite(true) });
      try {
        const withConsent = await runOnce(project);
        const tapOf = (run: Awaited<ReturnType<typeof runOnce>>) =>
          run.steps.findLast((step) => step.api === 'agent.tap')!;
        expect(tapOf(withConsent).cache!.status).toBe('written');

        // The prelude does not happen this time, exactly like a consent dialog
        // that never showed up.
        writeFileSync(
          path.join(project.dir, 'tests', 'conditional.e2e.ts'),
          suite(false),
          'utf8',
        );
        const withoutConsent = await runOnce(project);
        expect(tapOf(withoutConsent).cache!.status).toBe('hit');
        expect(tapOf(withoutConsent).cache!.keyHash).toBe(tapOf(withConsent).cache!.keyHash);
        expect(withoutConsent.locateCalls).toBe(0);
      } finally {
        project.cleanup();
      }
    }, 240_000);

    it('still separates two identical calls in one test', async () => {
      const project = createProject({
        'tests/twice.e2e.ts': `import { test, expect } from 'e2e';

test('taps the same target twice', async ({ app, agent, screen }) => {
  await app.open();
  await agent.tap('the Increment button');
  await agent.tap('the Increment button');
  await expect(screen.getByRole('status')).toHaveText('2');
});
`,
      });
      try {
        const cold = await runOnce(project);
        const taps = cold.steps.filter((step) => step.api === 'agent.tap');
        expect(taps).toHaveLength(2);
        // Same method, instruction, and parameters. The occurrence index and
        // the counter's own text both separate them, so two entries are stored
        // and each replays for its own round.
        expect(taps[0]!.cache!.keyHash).not.toBe(taps[1]!.cache!.keyHash);
        expect(cacheFiles(project)).toHaveLength(2);

        const warm = await runOnce(project);
        expect(warm.locateCalls).toBe(0);
        for (const tap of warm.steps.filter((step) => step.api === 'agent.tap')) {
          expect(tap.cache!.status).toBe('hit');
        }
      } finally {
        project.cleanup();
      }
    }, 240_000);

    it('keeps hitting while the page content churns', async () => {
      // The property the cache lives or dies by. /feed re-renders different
      // offers and prices on every request; the target is named by its own
      // content, so its locator is still correct and the entry must survive.
      const project = createProject({
        'tests/feed.e2e.ts': `import { test, expect } from 'e2e';

test('refreshes the feed', async ({ app, agent, screen }) => {
  await app.open('/feed');
  await agent.tap('the Refresh feed button');
  await expect(screen.getByRole('status')).toHaveText('refreshed');
});
`,
      });
      try {
        const cold = await runOnce(project);
        expect(cold.steps[0]!.cache!.status).toBe('written');

        for (let run = 0; run < 3; run += 1) {
          const warm = await runOnce(project);
          expect(warm.passed).toBe(true);
          expect(warm.steps[0]!.cache!.status).toBe('hit');
          expect(warm.locateCalls).toBe(0);
        }
        // One entry, not one per run: churning content no longer forks the key.
        expect(cacheFiles(project)).toHaveLength(1);
      } finally {
        project.cleanup();
      }
    }, 240_000);

    it('refuses to record a target the model reports as positional', async () => {
      // A positional target must not be stored: the locator would be
      // content-addressed and would keep resolving to whatever occupied that
      // position when it was recorded.
      // The target itself is an ordinary stable button; what is under test is
      // that the model's positional report alone stops the write.
      const project = createProject({
        'tests/positional.e2e.ts': `import { test, expect } from 'e2e';

test('taps the first button', async ({ app, agent, screen }) => {
  await app.open('/feed');
  await agent.tap('the Refresh feed button');
  await expect(screen.getByRole('status')).toHaveText('refreshed');
});
`,
      });
      try {
        const first = await runPositional(project);
        expect(first.passed).toBe(true);
        expect(first.steps[0]!.cache!.status).toBe('miss');
        // Nothing on disk is the observable contract; the explanation is
        // debug-only and deliberately absent from the report.
        expect(cacheFiles(project)).toHaveLength(0);

        // Still not recorded on a second run, and still correct: every run pays
        // for one locate rather than replaying a drifting locator.
        const second = await runPositional(project);
        expect(second.passed).toBe(true);
        expect(second.locateCalls).toBe(1);
        expect(cacheFiles(project)).toHaveLength(0);
      } finally {
        project.cleanup();
      }
    }, 240_000);

    it('records a target addressed by its observed reference, by its selector', async () => {
      // Three identical buttons: no derived query addresses one of them, so the
      // action goes through the reference the observation handed out. The
      // reference itself is unstorable, but the driver's structural selector
      // re-finds the same element on the next run, which is what makes a page
      // full of repeated controls cacheable at all.
      const project = createProject({
        'tests/placed.e2e.ts': `import { test, expect } from 'e2e';

test('taps the third repeat', async ({ agent, screen, web }) => {
  await web.goto('/repeats');
  await agent.tap('the third Reserve now button');
  await expect(screen.getByRole('status')).toHaveText('C');
});
`,
      });
      try {
        const model = installFakeModel((call) => {
          const lines = call.lines.filter((line) => line.includes('Reserve now'));
          const id = /#(\S+)/.exec(lines.at(-1) ?? '')?.[1] ?? '';
          return {
            protocolVersion: 'agent-locate-1',
            target: { id, revision: call.revision },
            explanation: 'the last Reserve now button in the observation',
          };
        });
        const outcome = await runExisting(project, {
          appUrl: app.url,
          config: { tests: 'tests/**/*.e2e.ts', reporters: ['json'], agent: { model } },
        });
        expect(outcome.status).toBe('passed');
        const files = cacheFiles(project);
        expect(files).toHaveLength(1);
        const entry = JSON.parse(
          readFileSync(path.join(project.dir, '.e2e', 'cache', files[0]!), 'utf8'),
        );
        expect(entry.payload.locator.kind).toBe('web-selector');
        expect(entry.payload.expected).toMatchObject({ role: 'button', name: 'Reserve now' });
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
