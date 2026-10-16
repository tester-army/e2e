/**
 * What a run traces: each step's events in the report (the node a
 * deterministic action landed on, the readings an assertion polled, what the
 * app logged, the hook a step ran in) and the trace page the runner writes
 * for each test its `trace` mode keeps, which the run's last event names.
 * Driven through the real runner over the fake engine.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppLogEntry, EngineAttemptContext } from '../../src/engine/index.ts';
import type { E2EConfig } from '../../src/index.ts';
import type { RunEvent } from '../../src/run/events.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL } from '../helpers/fake-engine.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { runProject } from '../helpers/run-project.ts';

const SUITE = `import { test, expect } from 'e2e';

test.beforeEach(async ({ app }) => {
  await app.open('/');
});

test('saves, then expects two buttons', async ({ screen }) => {
  await screen.getByRole('button', { name: 'Submit' }).tap();
  await expect(screen.getByRole('button')).toHaveCount(2, { timeout: 300 });
});
`;

describe('traces', () => {
  it(
    "keeps each step's events, files what the app logged under the step it happened in, and writes the page the last event names",
    async () => {
      let log: ((entry: AppLogEntry) => void) | undefined;
      const fake = createFakeEngine({
        onStartAttempt: (context: EngineAttemptContext) => {
          log = context.appLog;
          log({ source: 'console', level: 'warning', text: 'booting' });
        },
        perform: () => {
          log?.({ source: 'network', level: 'error', text: `POST ${FAKE_APP_URL}/api/save 500 Internal Server Error` });
        },
      });
      const events: RunEvent[] = [];
      const { outcome, project } = await runProject(
        { 'tests/save.e2e.ts': SUITE },
        {
          appUrl: FAKE_APP_URL,
          config: { targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }], actionTimeout: 300 } as E2EConfig,
          runOptions: { onEvent: (event) => void events.push(event) },
        },
      );
      try {
        assertValidReport(outcome.report);
        const attempt = outcome.report.run.results[0]!.attempts[0]!;
        const [open, tap, count] = attempt.steps;
        expect(open).toMatchObject({ api: 'app.open', phase: 'beforeEach' });
        expect(open!.events).toEqual([]);
        expect(tap!.phase).toBeUndefined();
        expect(tap!.events).toEqual([expect.objectContaining({ kind: 'engine', name: 'tap', status: 'passed', detail: 'tap button "Submit"' })]);
        // Launched before any step, the warning belongs to none; the failed request to the tap that sent it.
        expect(attempt.appLog).toEqual([
          { source: 'console', level: 'warning', text: 'booting', at: expect.any(String) },
          { source: 'network', level: 'error', text: `POST ${FAKE_APP_URL}/api/save 500 Internal Server Error`, at: expect.any(String), step: tap!.index },
        ]);
        expect(count!.events).toEqual([expect.objectContaining({ kind: 'poll', name: 'expect', status: 'failed', detail: expect.stringMatching(/^count 1 \(1 match\) x\d+$/) })]);
        expect(count!.events[0]!.count).toBeGreaterThan(1);

        const finished = events.find((event) => event.type === 'run-finished');
        const pages = finished?.type === 'run-finished' ? Object.values(finished.traces ?? {}) : [];
        expect(pages).toEqual([expect.stringMatching(/^\.e2e\/results\/save-saves-then-expects-two-buttons-[0-9a-f]{16}\/trace\.md$/)]);
        const page = readFileSync(path.join(project.dir, pages[0]!), 'utf8');
        expect(page).toContain('1. ✓ `app.open` `/` (');
        expect(page).toContain('in beforeEach)');
        expect(page).toContain('   - ✗ network error: `POST /api/save 500 Internal Server Error`');
        expect(page).toContain('- before step 1 · ⚠ console warning: `booting`');
        expect(page).toContain('   - tap button "Submit" (');
        expect(page).toMatch(/ {3}- expect gave up after \d+ reads in [\d.]+m?s: count 1 \(1 match\) x\d+/);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'keeps the screen each step left and what the engine said the attempt ran on, in the report and on the page',
    async () => {
      let context: EngineAttemptContext | undefined;
      let taps = 0;
      const screenAfter = (names: readonly string[]) =>
        context?.screen?.({
          root: { ref: { id: 'root', revision: '' }, role: 'document', children: names.map((name, index) => ({ ref: { id: `t${taps}-${index}`, revision: '' }, role: 'button', name })) },
          viewport: { width: 390, height: 844 },
          location: `${FAKE_APP_URL}/`,
        });
      const fake = createFakeEngine({
        onStartAttempt: (attempt: EngineAttemptContext) => {
          context = attempt;
          attempt.environment({ device: 'Pixel 9', os: 'Android 16' });
        },
        perform: () => {
          taps += 1;
          screenAfter(taps === 1 ? ['Submit'] : ['Submit', 'Undo']);
        },
      });
      const suite = SUITE.replace("await screen.getByRole('button', { name: 'Submit' }).tap();", "await screen.getByRole('button', { name: 'Submit' }).tap();\n  await screen.getByRole('button', { name: 'Submit' }).tap();");
      const { outcome, project } = await runProject(
        { 'tests/save.e2e.ts': suite },
        { appUrl: FAKE_APP_URL, config: { targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }], actionTimeout: 300 } as E2EConfig },
      );
      try {
        assertValidReport(outcome.report);
        const attempt = outcome.report.run.results[0]!.attempts[0]!;
        expect(attempt.environment).toEqual({ device: 'Pixel 9', os: 'Android 16' });
        const [, first, second] = attempt.steps;
        expect(first!.screen).toMatchObject({ nodes: 2, changes: [] });
        expect(second!.screen).toMatchObject({ since: 1, changes: ['added button "Undo"'] });
        const page = readTrace(project.dir, outcome.report.run.results[0]!.id)!;
        expect(page).toContain('Ran on: device `Pixel 9` · os `Android 16`');
        expect(page).toContain('   - screen: 1 change since step 2 at `/`, 3 nodes\n     - `added button "Undo"`');
      } finally {
        project.cleanup();
      }
      // An attempt that keeps no trace asks the engine for no screens, and takes none from what the test observes.
      let asked: boolean | undefined;
      const untraced = createFakeEngine({ onStartAttempt: (attempt: EngineAttemptContext) => {
        asked = attempt.screen !== undefined;
      } });
      const off = await runProject(
        { 'tests/save.e2e.ts': suite },
        { appUrl: FAKE_APP_URL, config: { targets: [{ name: 'fake', platform: 'web', engine: untraced.engine, app: FAKE_APP }], actionTimeout: 300, trace: 'off' } as E2EConfig },
      );
      off.project.cleanup();
      expect(asked).toBe(false);
      const offSteps = off.outcome.report.run.results.flatMap((result) => result.attempts.flatMap((attempt) => attempt.steps));
      expect(offSteps.length).toBeGreaterThan(0);
      expect(offSteps.filter((step) => step.screen !== undefined)).toEqual([]);
    },
    30_000,
  );

  it(
    'names the step whose error ended the test on the page and in the summary, not an earlier failure the test caught',
    async () => {
      // Every locator resolves but the banner, whose waitFor the test catches.
      const fake = createFakeEngine({
        locate: (expression) => (JSON.stringify(expression).includes('Banner') ? [] : [{ ref: { id: 'node-1', revision: '' }, role: 'button', name: 'Submit', states: { hidden: false } }]),
      });
      const suite = `import { test, expect } from 'e2e';

test.beforeEach(async ({ app }) => {
  await app.open('/');
});

test('tolerates a missing banner, then expects two buttons', async ({ screen }) => {
  try {
    await screen.getByRole('button', { name: 'Banner' }).waitFor({ timeout: 100 });
  } catch {
    // the banner is optional
  }
  await screen.getByRole('button', { name: 'Submit' }).tap();
  await expect(screen.getByRole('button')).toHaveCount(2, { timeout: 300 });
});
`;
      const { outcome, project } = await runProject(
        { 'tests/banner.e2e.ts': suite },
        {
          appUrl: FAKE_APP_URL,
          config: { targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }], reporters: ['markdown'], actionTimeout: 300 } as E2EConfig,
        },
      );
      try {
        assertValidReport(outcome.report);
        const result = outcome.report.run.results[0]!;
        const attempt = result.attempts[0]!;
        expect(attempt.error?.code).toBe('ASSERTION_FAILED');
        expect(attempt.steps.map((step) => [step.api, step.status, step.error?.code])).toEqual([
          ['app.open', 'passed', undefined],
          ['locator.waitFor', 'failed', 'LOCATOR_NOT_FOUND'],
          ['locator.tap', 'passed', undefined],
          ['expect.toHaveCount', 'failed', 'ASSERTION_FAILED'],
        ]);
        // The line and the lead are the assertion's; the caught step is listed, not named.
        const [, waitFor, , count] = attempt.steps;
        expect(count!.source.line).not.toBe(waitFor!.source.line);
        const page = readTrace(project.dir, result.id)!;
        expect(page).toContain(`Look at: \`tests/banner.e2e.ts:${count!.source.line}\``);
        expect(page).toContain('2. ✗ `locator.waitFor`');
        expect(page).toContain('4. ✗ `expect.toHaveCount`');
        const summary = readFileSync(path.join(project.dir, '.e2e', 'summary.md'), 'utf8');
        expect(summary).toContain(`\`tests/banner.e2e.ts:${count!.source.line}\`\n\n**ASSERTION_FAILED** at step 4 of 4: \`expect.toHaveCount getByRole("button")\`, after `);
        expect(summary).not.toContain('locator.waitFor');
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'names the step of a call split across lines, whose error unwinds through the line above its call site',
    async () => {
      const fake = createFakeEngine();
      const suite = `import { test, expect } from 'e2e';

test('split call', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button', { name: 'Submit' }))
    .toHaveCount(2, { timeout: 300 });
});
`;
      // A JavaScript file: the harness loads a TypeScript fixture without its source map, which folds the two lines into one.
      const { outcome, project } = await runProject(
        { 'tests/split.e2e.mjs': suite },
        {
          appUrl: FAKE_APP_URL,
          config: { tests: 'tests/**/*.e2e.mjs', targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }], reporters: ['markdown'], actionTimeout: 300 } as E2EConfig,
        },
      );
      try {
        const attempt = outcome.report.run.results[0]!.attempts[0]!;
        const count = attempt.steps[1]!;
        expect(count.error?.source).toEqual(attempt.error?.source);
        expect(count.source.line).not.toBe(attempt.error?.source?.line);
        const summary = readFileSync(path.join(project.dir, '.e2e', 'summary.md'), 'utf8');
        expect(summary).toContain('**ASSERTION_FAILED** at step 2 of 2: `expect.toHaveCount getByRole("button", name: "Submit")`, after ');
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'writes no page for a passing run by default',
    async () => {
      const fake = createFakeEngine();
      const passing = SUITE.replace('toHaveCount(2', 'toHaveCount(1');
      const { outcome, project } = await runProject(
        { 'tests/save.e2e.ts': passing },
        { appUrl: FAKE_APP_URL, config: { targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }] } as E2EConfig },
      );
      try {
        expect(outcome.status).toBe('passed');
        expect(outcome.report.run.results.map((result) => readTrace(project.dir, result.id))).toEqual([undefined]);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'keeps the traces the mode asks for: none under off, a passing test under on, a retry under --trace on-first-retry',
    async () => {
      const suite = `import { test, expect } from 'e2e';

test('passes', async ({ app }) => {
  await app.open('/');
});

test('fails', async ({ app }) => {
  await app.open('/');
  throw new Error('nope');
});
`;
      /** The titles of the results a run with `config` and `runOptions` kept a trace page for. */
      const traced = async (config: Partial<E2EConfig>, runOptions: { trace?: 'on-first-retry' } = {}): Promise<string[]> => {
        const fake = createFakeEngine();
        const { outcome, project } = await runProject(
          { 'tests/modes.e2e.ts': suite },
          { appUrl: FAKE_APP_URL, config: { targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }], ...config } as E2EConfig, runOptions },
        );
        try {
          const finished = outcome.report.run.results.filter((result) => readTrace(project.dir, result.id) !== undefined);
          return finished.map((result) => result.titlePath.at(-1)!).toSorted();
        } finally {
          project.cleanup();
        }
      };
      expect(await traced({ trace: 'off' })).toEqual([]);
      expect(await traced({ trace: 'on' })).toEqual(['fails', 'passes']);
      expect(await traced({ retries: 1, trace: 'off' }, { trace: 'on-first-retry' })).toEqual(['fails']);
      expect(await traced({ trace: 'on-first-retry' })).toEqual([]);
    },
    60_000,
  );
});

/** The trace page of result `id`, `trace.md` in its directory under the project's `.e2e/results/`, if one was written. */
function readTrace(dir: string, id: string): string | undefined {
  const results = path.join(dir, '.e2e', 'results');
  if (!existsSync(results)) return undefined;
  const name = readdirSync(results).find((entry) => entry.endsWith(`-${id.slice(0, 16)}`));
  const page = name === undefined ? undefined : path.join(results, name, 'trace.md');
  return page === undefined || !existsSync(page) ? undefined : readFileSync(page, 'utf8');
}
