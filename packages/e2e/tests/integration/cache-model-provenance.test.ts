import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ModelInstance } from '../../src/types.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { startFixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { contentsUnder, createProject, runExisting } from '../helpers/run-project.ts';
import { onlyActStep, readEntries } from '../helpers/trace-cache.ts';
import { ListReporter } from '../../src/report/list.ts';

const TITLE = 'model provenance';
const SUITE = `import { test, expect } from 'e2e';
test('${TITLE}', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status', 'Counter')).toHaveText('2');
});

`;

/** Supplies real tool-loop responses under a distinct model id without contacting a provider. */
function counterModel(modelId: string): ModelInstance {
  const model = installFakeLoopModel((call) => {
    const screen = call.lastToolResult === '' ? call.prompt : call.lastToolResult;
    if (/"Counter" text="2"/u.test(screen)) {
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'the counter shows 2' } }];
    }
    const target = nodeIdFor(screen, /button "Increment"/u);
    const remaining = /"Counter" text="1"/u.test(screen) ? 1 : 2;
    return Array.from({ length: remaining }, () => ({ toolName: 'tap', input: { target } }));
  });
  return { ...model, modelId };
}

it.each(['same', 'different', 'legacy', 'null', 'invalid-model', 'missing-provider', 'blank-model', 'oversized-provider', 'oversized-model'])('reports recording attribution without changing replay, %s', async (mode) => {
  const app = await startFixtureApp();
  const project = createProject({ 'tests/provenance.e2e.ts': SUITE });
  const source = { provider: 'fake-loop', model: 'model-A' };
  try {
    const recorded = await runExisting(project, { appUrl: app.url, config: { agents: { default: { model: counterModel('model-A') } } } });
    expect(recorded.exitCode).toBe(0);
    const [entry] = readEntries(project);
    expect(entry!.entry.payload.recordedBy).toEqual(source);
    const known = mode === 'same' || mode === 'different';
    if (!known) {
      const { recordedBy: _recordedBy, ...payload } = entry!.entry.payload;
      const invalid: Record<string, unknown> = {
        null: null, 'invalid-model': { provider: 'test', model: 1 }, 'missing-provider': { model: 'test' },
        'blank-model': { provider: 'test', model: ' ' }, 'oversized-provider': { provider: 'x'.repeat(301), model: 'A' }, 'oversized-model': { provider: 'test', model: 'x'.repeat(301) },
      };
      writeFileSync(entry!.file, JSON.stringify({ ...entry!.entry, payload: { ...payload, ...(mode === 'legacy' ? {} : { recordedBy: invalid[mode] }) } }));
    }
    const before = readFileSync(entry!.file, 'utf8');
    const lines: string[] = [];
    const list = new ListReporter({ write: (line) => lines.push(line) }, { live: false, colors: false });
    const replayed = await runExisting(project, {
      appUrl: app.url,
      config: {
        agents: { default: { model: counterModel(mode === 'same' ? 'model-A' : 'model-B') } }, cache: { mode: 'read-write', strict: true }, trace: 'on',
        reporters: [{ name: 'capture', onEvent: (event) => list.handle(event) }],
      },
    });
    expect(replayed.exitCode).toBe(0);
    expect(loopCalls).toHaveLength(0);
    const step = onlyActStep(replayed, TITLE);
    expect(step.cache?.mode).toBe('self-finalized');
    expect(step.cache?.recordedBy).toEqual(known ? source : undefined);
    expect(step.model).toBeUndefined();
    expect(lines.filter((line) => line.includes('recorded with'))).toEqual(mode === 'different' ? [expect.stringContaining('replayed · recorded with fake-loop/model-A')] : []);
    expect(readFileSync(entry!.file, 'utf8')).toBe(before);
    const traces = contentsUnder(path.join(project.dir, '.e2e/results')).filter(([name]) => name.endsWith('trace.md'));
    expect(traces.some(([, text]) => text.includes('recorded with `fake-loop/model-A`'))).toBe(known);
    assertValidReport(replayed.report);
  } finally {
    project.cleanup();
    await app.close();
  }
});

it.each([true, false])('attributes an executor to its configured model only, configured=%s', async (configured) => {
  const app = await startFixtureApp();
  const project = createProject({ 'tests/provenance.e2e.ts': SUITE });
  let calls = 0;
  const executor: StepExecutor = {
    name: 'mixed-model', version: '1', cache: 'inherit',
    ...(configured ? { model: counterModel('text-model') } : {}),
    async runStep(ctx) {
      calls += 1;
      ctx.budgets.recordModelCall(configured ? { provider: 'fake-loop', modelId: 'text-model' } : undefined);
      const observed = await ctx.observe();
      const target = { id: nodeIdFor(observed.text, /button "Increment"/u) };
      await ctx.actions.tap(target);
      await ctx.actions.tap(target);
      ctx.budgets.recordModelCall(configured ? { provider: 'decision-provider', modelId: 'decision-model' } : undefined);
      return { status: 'passed', summary: 'the counter shows 2' };
    },
  };
  const lines: string[] = [];
  const list = new ListReporter({ write: (line) => lines.push(line) }, { live: false, colors: false });
  const config = { agents: { default: { executor } }, reporters: [{ name: 'capture', onEvent: (event: Parameters<ListReporter['handle']>[0]) => list.handle(event) }] };
  try {
    const recorded = await runExisting(project, { appUrl: app.url, config });
    expect(recorded.exitCode).toBe(0);
    const [entry] = readEntries(project);
    expect(entry!.entry.payload.recordedBy).toEqual(configured ? { provider: 'fake-loop', model: 'text-model' } : undefined);
    expect(onlyActStep(recorded, TITLE).model).toMatchObject(configured ? { provider: 'decision-provider', model: 'decision-model', calls: 2 } : { provider: 'mixed-model', model: 'mixed-model', calls: 2 });
    lines.length = 0;
    const replayed = await runExisting(project, { appUrl: app.url, config });
    expect(replayed.exitCode).toBe(0);
    expect(calls).toBe(1);
    expect(onlyActStep(replayed, TITLE).cache?.recordedBy).toEqual(entry!.entry.payload.recordedBy);
    expect(lines.filter((line) => line.includes('recorded with'))).toEqual([]);
    assertValidReport(replayed.report);
  } finally {
    project.cleanup();
    await app.close();
  }
});
