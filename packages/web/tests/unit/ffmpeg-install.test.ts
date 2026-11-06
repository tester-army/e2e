/**
 * `ensureFfmpeg` against a cache and a mirror of the test's own, with no
 * ffmpeg on the PATH, so the download path runs whatever the machine has.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserExecutable, ensureBrowsersInstalled, ensureFfmpeg } from '../../src/install.ts';
import { startArchiveServer, type ArchiveServer } from '../helpers/archive-server.ts';

const KEY = `${process.platform}-${process.arch}`;
const PINNED = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'].includes(KEY);

let cache = '';
let server: ArchiveServer;
let env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  vi.stubEnv('PATH', '');
  cache = mkdtempSync(path.join(tmpdir(), 'e2e-ffmpeg-'));
  server = await startArchiveServer();
  env = { E2E_BROWSERS_PATH: cache, E2E_BROWSERS_DOWNLOAD_HOST: server.origin };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await server.close();
  rmSync(cache, { recursive: true, force: true });
});

describe('ensureFfmpeg', () => {
  it('returns E2E_FFMPEG_PATH without downloading', async () => {
    expect(await ensureFfmpeg({ ...env, E2E_FFMPEG_PATH: '/opt/ffmpeg' })).toBe('/opt/ffmpeg');
    expect(server.requests).toEqual([]);
  });

  it('is not downloaded by preparing a chromium run', async () => {
    const executable = await browserExecutable('chromium', false, env);
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, '');
    await ensureBrowsersInstalled(['chromium'], { env, log: () => {} });
    expect(server.requests).toEqual([]);
  });

  it.runIf(PINNED)('downloads the pinned build from the mirror and refuses one with another SHA-256', async () => {
    server.route(`/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-${KEY}.gz`, Buffer.from('not ffmpeg'));
    const logs: string[] = [];
    await expect(ensureFfmpeg(env, { log: (line) => logs.push(line) })).rejects.toMatchObject({
      code: 'BROWSER_INSTALL_FAILED',
      message: expect.stringMatching(/^could not install ffmpeg: download of .* has SHA-256 [0-9a-f]{64}, expected [0-9a-f]{64}; refusing it; run "npx @e2e-dev\/web install ffmpeg"/),
    });
    expect(logs).toEqual([`Downloading ffmpeg from ${server.origin}/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-${KEY}.gz`]);
    expect(readdirSync(cache)).toEqual([]);
  });

  it('fails a platform with no pinned build with UNSUPPORTED_CAPABILITY', async () => {
    const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
    Object.defineProperty(process, 'arch', { value: 'riscv64' });
    try {
      await expect(ensureFfmpeg(env)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('set E2E_FFMPEG_PATH') });
    } finally {
      Object.defineProperty(process, 'arch', arch);
    }
    expect(existsSync(path.join(cache, '.install.lock'))).toBe(false);
    expect(server.requests).toEqual([]);
  });
});
