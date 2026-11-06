/** `openEngine` through the built runner: one attempt on a bare engine, its fixtures, and a close that ends what it opened. */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';

const runnerModule = new URL('../../dist/runner.js', import.meta.url).href;
const { openEngine } = (await import(runnerModule)) as typeof import('../../src/runner.ts');
const PROJECTS = new URL('../tmp-projects/', import.meta.url);

describe('openEngine', { timeout: 60_000 }, () => {
  let dir: string;

  beforeEach(() => {
    mkdirSync(PROJECTS, { recursive: true });
    dir = mkdtempSync(path.join(PROJECTS.pathname, 'open-engine-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('hands back screen and the engine fixtures, then ends the attempt and disposes the engine once', async () => {
    const fake = createFakeEngine({ fixtures: true, platform: 'kiosk' });
    const session = await openEngine<{ gadget: { poke(what: string): Promise<string> } }>(fake.engine, { cwd: dir, env: {} });
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 1, attemptsEnded: 0 });

    expect(await session.fixtures.screen.getByRole('button', 'Submit').count()).toBe(1);
    expect(await session.fixtures.gadget.poke('it')).toBe('poked it');

    await session.close();
    await session.close();
    expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
    expect(readdirSync(dir)).toEqual([]);
  });
});
