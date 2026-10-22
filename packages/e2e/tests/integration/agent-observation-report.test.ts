/** Agent steps report when any semantic observation was truncated. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineEngine, type EngineSnapshot } from '../../src/engine/index.ts';
import { installFakeLoopModel } from '../helpers/fake-loop-model.ts';
import { installFakeModel, judgment } from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from 'e2e';

test('reports a truncated act observation', async ({ agent }) => {
  await agent.act('inspect the visible result');
});

test('reports a truncated judgment observation', async ({ agent }) => {
  await agent.assert('the Save button is visible');
});
`;

/** One small tree marked as cut by the engine, as a large page would be. */
function truncatedSnapshot(): EngineSnapshot {
  return {
    root: {
      ref: { id: 'root', revision: '' },
      children: [{ ref: { id: 'save', revision: '' }, role: 'button', name: 'Save' }],
    },
    location: 'https://fixture.test/result',
    viewport: { width: 800, height: 600 },
    truncated: true,
  };
}

describe('agent observation report fields', () => {
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    const engine = defineEngine({
      name: 'truncated-observation-fixture',
      version: '1',
      spiVersion: 1,
      platform: 'fixture',
      observe: async () => truncatedSnapshot(),
    });
    const model = installFakeLoopModel(() => [
      { toolName: 'complete_step', input: { status: 'passed', summary: 'the result is visible' } },
    ]);
    const judge = installFakeModel(() => judgment(true, 'the Save button is visible'));
    const result = await runProject(
      { 'tests/truncated.e2e.ts': SUITE },
      {
        appUrl: 'https://fixture.test',
        config: {
          tests: 'tests/**/*.e2e.ts',
          targets: [{ name: 'fixture', engine }],
          agents: { default: { model, judge } },
        },
      },
    );
    outcome = result.outcome;
    project = result.project;
  });

  afterAll(() => project?.cleanup());

  it.each([
    ['reports a truncated act observation', 'agent.act'],
    ['reports a truncated judgment observation', 'agent.assert'],
  ] as const)('marks %s', (title, api) => {
    const result = resultByTitle(outcome, title);
    expect(result.status).toBe('passed');
    expect(result.attempts[0]?.steps.find((step) => step.api === api)?.observationTruncated).toBe(true);
  });

  it('writes a valid report-1 document', () => {
    assertValidReport(outcome.report);
  });
});
