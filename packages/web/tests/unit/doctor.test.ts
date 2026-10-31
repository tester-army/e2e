/** The web engine's `e2e doctor` checks: the browser a local launch needs, and the init scripts `prepare` reads. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EngineDoctorInfo } from 'e2e/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { web, type BrowserProvider } from '../../src/index.ts';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-web-doctor-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

const info = (): EngineDoctorInfo => ({
  targetName: 'web',
  projectRoot,
  app: {},
  env: process.env,
  headed: false,
  signal: new AbortController().signal,
  log: () => {},
});

const provider: BrowserProvider = {
  name: 'toy-cloud',
  acquire: async () => ({ id: 'lease-0', cdpEndpoint: 'wss://0.example' }),
  release: async () => undefined,
};

describe('web doctor', () => {
  it('skips the browser check for a CDP attach and a browser provider', async () => {
    expect(await web({ connect: { cdpEndpoint: async () => 'http://127.0.0.1:9222' } }).doctor!(info())).toEqual([
      { id: 'browser', status: 'skip', message: 'the browser is attached over CDP' },
    ]);
    expect(await web({ browser: provider }).doctor!(info())).toEqual([{ id: 'browser', status: 'skip', message: 'browsers come from the "toy-cloud" provider' }]);
  });

  it('checks the browser of a local launch', async () => {
    const checks = await web().doctor!(info());
    expect(checks.map((check) => check.id)).toEqual(['browser']);
  });

  it('fails an init script file that does not read, as prepare would', async () => {
    writeFileSync(path.join(projectRoot, 'present.js'), 'window.present = true;');
    const engine = web({ initScripts: [{ path: 'present.js' }, { path: 'missing.js' }], connect: { cdpEndpoint: async () => 'http://127.0.0.1:9222' } });
    const [scripts] = await engine.doctor!(info());
    expect(scripts).toMatchObject({ id: 'init-scripts', status: 'fail' });
    expect(scripts?.message).toContain('missing.js');
    const present = web({ initScripts: [{ path: 'present.js' }], connect: { cdpEndpoint: async () => 'http://127.0.0.1:9222' } });
    expect((await present.doctor!(info()))[0]).toEqual({ id: 'init-scripts', status: 'pass', message: '1 script reads' });
  });
});
