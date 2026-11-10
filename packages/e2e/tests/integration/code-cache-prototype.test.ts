import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { emitTest } from '../../scripts/code-cache-emit.ts';
import { startFixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExisting, workerConfigSource } from '../helpers/run-project.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { readEntries } from '../helpers/trace-cache.ts';
import type { StepExecutor } from '../../src/index.ts';

it('records an agent flow, emits ordinary code, and runs it without an agent', async () => {
  const app = await startFixtureApp();
  const project = createProject({ 'tests/counter.e2e.ts': `import { test, expect } from 'e2e';
 test('counter', async ({ app, agent, screen }) => {
   await app.open('/');
   await expect(screen.getByRole('button', 'Late arrival')).toBeVisible();
   await agent.act('increment twice');
   await expect(screen.getByRole('status')).toHaveText('2');
 });` });
  let calls = 0;
  const executor: StepExecutor = {
    name: 'prototype-counter',
    async runStep(context) {
      calls += 1;
      for (let index = 0; index < 2; index += 1) {
        const observation = await context.observe();
        await context.actions.tap({ id: nodeIdFor(observation.text, /button "Increment"/u) });
      }
      await context.observe();
      return { status: 'passed', summary: 'Incremented twice' };
    },
  };
  try {
    const recorded = await runExisting(project, { appUrl: app.url, config: { cache: 'read-write', agents: { default: { executor } } } });
    expect(recorded.exitCode).toBe(0);
    expect(calls).toBe(1);
    const entries = readEntries(project);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!.entry;
    const source = emitTest(entry, 'counter');
    expect(source).toMatchSnapshot();
    expect(source).toContain('.tap()');
    expect(source).not.toContain('agent.act');
    expect(emitTest({ ...entry, createdAt: '2030-01-01T00:00:00.000Z' }, 'counter')).toBe(source);
    writeFileSync(path.join(project.dir, 'tests/counter.e2e.ts'), source);
    const replayed = await runExisting(project, { appUrl: app.url, config: { cache: 'off' } });
    expect(replayed.exitCode, JSON.stringify(replayed.report)).toBe(0);
    expect(calls).toBe(1);
    writeFileSync(path.join(project.dir, 'e2e.config.ts'), workerConfigSource(1));
    const cli = await promisify(execFile)(process.execPath, [path.resolve('dist/cli/bin.js'), 'run', '--no-cache'], {
      cwd: project.dir, env: { ...process.env, CI: '', APP_URL: app.url },
    });
    expect(cli.stdout).toContain('1 passed');
    // A broken expected outcome must fail instead of declaring a cache hit.
    writeFileSync(path.join(project.dir, 'tests/counter.e2e.ts'), source.replaceAll('^2$', '^3$'));
    const broken = await runExisting(project, { appUrl: app.url, config: { cache: 'off', timeout: 5_000 } });
    expect(broken.exitCode).not.toBe(0);
  } finally {
    project.cleanup();
    await app.close();
  }
}, 120_000);
