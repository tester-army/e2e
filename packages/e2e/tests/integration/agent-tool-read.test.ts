/** Project-tool reads cross the built runner's engine protocol and secret boundary. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, getToolContext } from '../../src/agent/tool.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

describe('project tool computed style', () => {
  let app: FixtureApp;
  beforeAll(async () => { app = await startFixtureApp(); });
  afterAll(async () => { await app.close(); });

  it('measures styles without pixels and keeps secret values out of model input and reports', async () => {
    const sentinel = '0.314159';
    let measured: unknown;
    const model = installFakeLoopModel(({ turn }) => turn === 1
      ? [{ toolName: 'inspect', input: {} }]
      : [{ toolName: 'complete_step', input: { status: 'passed', summary: 'measured the error style' } }]);
    const tools = { inspect: defineTool({ inputSchema: z.object({}), execute: async (_input, options) => {
      const context = getToolContext(options);
      const screen = await context.observe({ tree: true });
      const line = screen.text.split('\n').find((entry) => entry.includes('button "Error"'));
      const id = /#(\S+)/u.exec(line ?? '')?.[1];
      if (id === undefined) throw new Error('error button is missing');
      measured = await context.read({ id }, { style: ['color', 'font-weight', 'opacity'] });
      return measured;
    } }, { mutates: false }) };
    const { project, outcome } = await runProject({ 'tests/style.e2e.ts': `
      import { test, expect } from 'e2e';
      test('measures an error style', async ({ app, browser, agent, screen }) => {
        await app.open();
        await browser.evaluate(() => {
          document.body.innerHTML = '<button style="color: red; font-weight: 700; opacity: ${sentinel}">Error</button>';
        });
        await agent.act('measure the error style');
        await expect(screen.getByRole('button', 'Error')).toBeVisible();
      });
    ` }, { appUrl: app.url, config: { secrets: { tone: sentinel }, cache: 'off', agents: { default: { model, tools } } } });
    try {
      expect(outcome.exitCode).toBe(0);
      expect(measured).toEqual({ style: { color: 'rgb(255, 0, 0)', 'font-weight': '700', opacity: '<secret:tone>' } });
      expect(loopCalls.at(-1)?.lastToolResult).toContain('rgb(255, 0, 0)');
      expect(JSON.stringify(loopCalls)).not.toContain(sentinel);
      expect(JSON.stringify(outcome.report)).not.toContain(sentinel);
      const step = resultByTitle(outcome, 'measures an error style').attempts[0]?.steps.find((entry) => entry.api === 'agent.act');
      expect(step?.metrics?.actionSteps).toBe(0);
    } finally { project.cleanup(); }
  });
});
