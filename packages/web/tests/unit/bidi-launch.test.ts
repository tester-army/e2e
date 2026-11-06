/**
 * A local launch without a real browser: the executable comes from the run's
 * environment, never this process's, and the watchdog a browser runs under
 * kills it and removes its profile once the launching process lets go.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { launchBidiBrowser } from '../../src/bidi/launch.ts';
import { watchdogArgs } from '../../src/bidi/browser-watchdog.ts';

const WATCHDOG = fileURLToPath(new URL('../../src/bidi/browser-watchdog.ts', import.meta.url));

/** Whether a process with `pid` still runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('launchBidiBrowser', () => {
  it('looks the build up in the browsers cache the run environment names', async () => {
    const cache = path.join(os.tmpdir(), 'e2e-no-such-browsers-cache');
    await expect(launchBidiBrowser('chromium', { headed: false, timeoutMs: 10_000, env: { E2E_BROWSERS_PATH: cache }, signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining(cache),
    });
  });

  it('fails CANCELLED without starting anything once its signal aborted', async () => {
    await expect(launchBidiBrowser('chromium', { headed: false, timeoutMs: 10_000, env: {}, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('browser watchdog', () => {
  it('kills the browser and removes its profile once its stdin closes, as when the launching process is killed', async () => {
    const profile = mkdtempSync(path.join(os.tmpdir(), 'e2e-watchdog-test-'));
    const browserLike = ['-e', 'console.error(`pid ${process.pid}`); setInterval(() => undefined, 1000);'];
    const watchdog = spawn(process.execPath, [WATCHDOG, ...watchdogArgs(profile, process.execPath, browserLike)], { stdio: ['pipe', 'ignore', 'pipe'] });
    const pid = await new Promise<number>((resolve) => watchdog.stderr.on('data', (chunk: Buffer) => {
      const match = /pid (\d+)/.exec(chunk.toString());
      if (match !== null) resolve(Number(match[1]));
    }));
    expect(alive(pid)).toBe(true);
    const exited = new Promise<void>((resolve) => watchdog.once('exit', () => resolve()));
    watchdog.stdin.destroy();
    await exited;
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    expect(existsSync(profile)).toBe(false);
  });

  it('removes the profile and exits with the browser when the browser exits on its own', async () => {
    const profile = mkdtempSync(path.join(os.tmpdir(), 'e2e-watchdog-test-'));
    const watchdog = spawn(process.execPath, [WATCHDOG, ...watchdogArgs(profile, process.execPath, ['-e', 'process.exit(3)'])], { stdio: ['pipe', 'ignore', 'ignore'] });
    const code = await new Promise<number | null>((resolve) => watchdog.once('exit', (exitCode) => resolve(exitCode)));
    expect(code).toBe(3);
    expect(existsSync(profile)).toBe(false);
  });
});
