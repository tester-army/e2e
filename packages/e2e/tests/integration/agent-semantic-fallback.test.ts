import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineEngine, EngineError, type EngineObserveOptions } from '../../src/engine/index.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';
import { fakeCalls, installFakeModel, judgment } from '../helpers/fake-model.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';
import { assertValidReport } from '../helpers/report-schema.ts';

const SUITE = `import { test, credentials } from 'e2e';
test('act receives fallback on its first observation', async ({ agent }) => {
  await agent.act('read the visible screenshot');
});
test('vision judgment receives fallback', async ({ agent }) => {
  await agent.assert('the screenshot shows the result', { vision: true });
});
test('tree-only judgment cannot infer absence', async ({ agent }) => {
  await agent.assert('nothing is visible', { vision: false });
});
test('act cannot recover pixels after a secret fill', async ({ agent, screen }) => {
  await screen.getByRole('textbox').fill(credentials.user('member').password);
  await agent.act('read the tainted screenshot');
});
test('judgment cannot recover pixels after a secret fill', async ({ agent, screen }) => {
  await screen.getByRole('textbox').fill(credentials.user('member').password);
  await agent.assert('read the tainted result', { vision: true });
});`;

describe('agent semantic fallback through the engine contract', () => {
  let project: FixtureProject;
  let outcome: RunOutcome;
  const captures: { filled: boolean; options: EngineObserveOptions | undefined }[] = [];

  beforeAll(async () => {
    let filled = false;
    const engine = defineEngine({
      name: 'masked-fixture', version: '1', spiVersion: 1, platform: 'fixture',
      actions: ['fill'],
      startAttempt: async () => { filled = false; },
      locate: async () => [{ ref: { id: 'password', revision: '' }, role: 'textbox', inputPurpose: 'password', states: { secure: true } }],
      perform: async () => { filled = true; },
      observe: async (_operation, options) => {
        captures.push({ filled, options });
        if (options?.pixelFallback !== true) {
          throw new EngineError('OPERATION_TIMEOUT', 'semantic capture timed out', { retryable: false });
        }
        return {
          root: { ref: { id: 'root', revision: '' } },
          location: 'fixture:result',
          viewport: { width: 2, height: 2, scale: 1 },
          treeUnavailable: true,
          pixels: { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 2, height: 2, scale: 1 },
          maskedRegionCount: 0,
        };
      },
    });
    const model = installFakeLoopModel(() => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read pixels' } }]);
    const judge = installFakeModel(() => judgment(true, 'visible in the screenshot'));
    const result = await runProject({ 'tests/fallback.e2e.ts': SUITE }, {
      appUrl: 'https://fixture.test',
      config: {
        tests: 'tests/**/*.e2e.ts',
        targets: [{ name: 'fixture', engine }],
        agents: { default: { model, judge } },
        credentials: { member: { username: 'member', password: 'fixture-secret-value' } },
      },
    });
    project = result.project;
    outcome = result.outcome;
    expect(outcome.report.run.errors).toEqual([]);
  });

  afterAll(() => project?.cleanup());

  it('sends the first fallback screenshot and the warning to the acting model', () => {
    expect(resultByTitle(outcome, 'act receives fallback on its first observation').status).toBe('passed');
    expect(loopCalls).toHaveLength(1);
    expect(loopCalls[0]!.imageParts).toBe(1);
    expect(loopCalls[0]!.prompt).toContain('Screenshot attached: 2 by 2');
    expect(loopCalls[0]!.prompt).toContain('semantic capture unavailable');
    expect(loopCalls[0]!.prompt).toContain('never infer absence');
    expect(captures[0]?.options).toEqual({ pixelFallback: true });
    const step = resultByTitle(outcome, 'act receives fallback on its first observation').attempts[0]!.steps.find((entry) => entry.api === 'agent.act');
    expect(step?.visionInput).toBe(true);
  });

  it('judges the current screenshot with vision enabled', () => {
    expect(resultByTitle(outcome, 'vision judgment receives fallback').status).toBe('passed');
    expect(fakeCalls).toHaveLength(1);
    expect(fakeCalls[0]!.images).toEqual([{ mediaType: 'image/png', bytes: 3 }]);
    expect(fakeCalls[0]!.observation).toContain('semantic capture unavailable');
  });

  it('stops tree-only and tainted judgments before a model call', () => {
    for (const title of ['tree-only judgment cannot infer absence', 'act cannot recover pixels after a secret fill', 'judgment cannot recover pixels after a secret fill']) {
      const result = resultByTitle(outcome, title);
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error?.message).toContain('timed out');
    }
    const tainted = captures.filter((capture) => capture.filled);
    expect(tainted.length).toBeGreaterThanOrEqual(2);
    expect(tainted.every((capture) => capture.options?.pixelFallback !== true && capture.options?.pixels !== true)).toBe(true);
    assertValidReport(outcome.report);
  });
});
