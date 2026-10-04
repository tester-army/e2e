/**
 * What a failed run tells without a recording: each step's events in the
 * report (the node a deterministic action landed on, the readings an
 * assertion polled, what the app logged, the hook a step ran in) and the
 * failure page the runner writes for the test, which the run's last event
 * names. Driven through the real runner over the fake engine.
 */

import { existsSync, readFileSync } from 'node:fs';
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

describe('failure pages', () => {
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
        const [open, tap, count] = outcome.report.run.results[0]!.attempts[0]!.steps;
        expect(open).toMatchObject({ api: 'app.open', phase: 'beforeEach' });
        // Launched before any step, the warning waits for the first one.
        expect(open!.events).toEqual([expect.objectContaining({ kind: 'app', name: 'console', level: 'warning', detail: 'booting' })]);
        expect(tap!.phase).toBeUndefined();
        expect(tap!.events).toEqual([
          expect.objectContaining({ kind: 'app', name: 'network', level: 'error', status: 'failed' }),
          expect.objectContaining({ kind: 'engine', name: 'tap', status: 'passed', detail: 'tap button "Submit"' }),
        ]);
        expect(count!.events).toEqual([expect.objectContaining({ kind: 'poll', name: 'expect', status: 'failed', detail: expect.stringMatching(/^count 1 \(1 match\) x\d+$/) })]);
        expect(count!.events[0]!.count).toBeGreaterThan(1);

        const finished = events.find((event) => event.type === 'run-finished');
        const pages = finished?.type === 'run-finished' ? Object.values(finished.failurePages ?? {}) : [];
        expect(pages).toEqual([expect.stringMatching(/^\.e2e\/failures\/save-saves-then-expects-two-buttons-[0-9a-f]{8}\.md$/)]);
        const page = readFileSync(path.join(project.dir, pages[0]!), 'utf8');
        expect(page).toContain('1. ✓ `app.open` `/` (');
        expect(page).toContain('in beforeEach)');
        expect(page).toContain('   - ✗ network error: `POST /api/save 500 Internal Server Error`');
        expect(page).toContain('   - tap button "Submit" (');
        expect(page).toMatch(/ {3}- expect gave up after \d+ reads in [\d.]+m?s: count 1 \(1 match\) x\d+/);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'writes no page for a passing run',
    async () => {
      const fake = createFakeEngine();
      const passing = SUITE.replace('toHaveCount(2', 'toHaveCount(1');
      const { outcome, project } = await runProject(
        { 'tests/save.e2e.ts': passing },
        { appUrl: FAKE_APP_URL, config: { targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }] } as E2EConfig },
      );
      try {
        expect(outcome.status).toBe('passed');
        expect(existsSync(path.join(project.dir, '.e2e', 'failures'))).toBe(false);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );
});
