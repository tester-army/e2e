/**
 * A restored session redacts what the session that saved it learned: a
 * provider-resolved secret filled during setup, stored by the app, and
 * echoed back after restore never reaches the failure message, the report,
 * or the failure screen, and the consumer's viewport stays tainted. A static
 * config secret is the control: every session registers those itself.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineEngine, LOCATOR_ACTION_KINDS } from '../../src/engine/index.ts';
import type { EngineState } from '../../src/engine/index.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, runExisting } from '../helpers/run-project.ts';
import { snapshot } from '../helpers/snapshot.ts';

const SENTINEL = 'synthetic-session-token-3141';

const files = {
  'tests/store.setup.e2e.ts': `import { test, secrets } from 'e2e';
test.setup('stores the token', { sessions: ['acct'] }, async ({ screen, session }) => {
  await screen.getByRole('textbox').fill(secrets.get('token'));
  await session.save('acct');
});`,
  'tests/echo.e2e.ts': `import { test, expect } from 'e2e';
test('meets the stored token again', { session: 'acct' }, async ({ screen, agent }) => {
  await agent.act('look at the echo');
  await expect(screen.getByRole('status')).toHaveText('nothing stored', { timeout: 200 });
});`,
};

describe('session secrecy across save and restore', () => {
  it.each(['provider', 'static'] as const)(
    'redacts a %s secret the restored state echoes back, in the failure, the report, and the failure screen',
    async (source) => {
      let echo = '';
      const observations: { secretVisible: boolean; withheld: string | undefined }[] = [];
      const engine = defineEngine({
        name: 'fake',
        version: '1',
        spiVersion: 1,
        startAttempt: async () => {
          echo = '';
        },
        observe: async (_operation, options) =>
          snapshot(
            [{ ref: { id: 'echo', revision: '' }, role: 'status', text: echo }],
            options?.pixels
              ? { pixels: { data: new Uint8Array([1]), mediaType: 'image/png' as const, width: 1, height: 1, scale: 1 }, maskedRegionCount: 0 }
              : {},
          ),
        locate: async () =>
          echo === ''
            ? [{ ref: { id: 'field', revision: '' }, role: 'textbox' }]
            : [{ ref: { id: 'echo', revision: '' }, role: 'status', text: echo }],
        actions: LOCATOR_ACTION_KINDS,
        perform: async (_ref, action) => {
          if (action.kind === 'fill') echo = action.value;
        },
        state: {
          capture: async (): Promise<EngineState> => ({ format: 'fake-state', version: 1, data: { stored: echo } }),
          restore: async (state) => {
            echo = (state.data as { stored: string }).stored;
          },
        },
      });
      const project = createProject(files);
      try {
        const outcome = await runExisting(project, {
          appUrl: 'http://127.0.0.1:4599',
          config: {
            targets: [{ name: 'fake', platform: 'custom', engine }],
            cache: 'off',
            secrets: { token: source === 'static' ? SENTINEL : () => SENTINEL },
            agents: {
              default: {
                executor: {
                  name: 'probe',
                  async runStep(context) {
                    const observation = await context.observe({ pixels: true });
                    observations.push({ secretVisible: observation.text.includes(SENTINEL), withheld: observation.pixelsWithheld });
                    return { status: 'passed', summary: 'observed' };
                  },
                },
              },
            },
          },
        });
        assertValidReport(outcome.report);
        const result = outcome.report.run.results.find((entry) => entry.titlePath.at(-1) === 'meets the stored token again')!;
        expect(result.status).toBe('failed');
        const attempt = result.attempts.at(-1)!;
        expect(attempt.error?.message).toContain('<secret:token>');
        expect(observations).toEqual([{ secretVisible: false, withheld: 'PIXEL_TAINTED' }]);
        const screen = attempt.artifacts.find((artifact) => artifact.id === attempt.failure?.screen);
        expect(screen?.path).toBeDefined();
        const screenFile = path.join(project.dir, '.e2e', 'results', screen!.path!);
        expect(existsSync(screenFile)).toBe(true);
        const screenText = readFileSync(screenFile, 'utf8');
        expect(screenText).toContain('<secret:token>');
        expect(screenText).not.toContain(SENTINEL);
        expect(JSON.stringify(outcome.report)).not.toContain(SENTINEL);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );
});
