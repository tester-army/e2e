/**
 * `e2e-core`'s Ctrl-C: a program that holds a host and gets SIGINT closes the
 * host, and the engine with it, then ends by the signal; a close that fails
 * says so on stderr before the process goes.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECTS = path.join(import.meta.dirname, '..', 'tmp-projects');
const FAKE_ENGINE = path.join(import.meta.dirname, '..', 'helpers', 'fake-engine.ts');

/** Runs a program that opens a host and a session, sends it SIGINT once it is ready, and reports how it ended. */
async function interrupt(failClose: boolean): Promise<{ signal: NodeJS.Signals | null; code: number | null; stderr: string; disposed: boolean }> {
  mkdirSync(PROJECTS, { recursive: true });
  const dir = mkdtempSync(path.join(PROJECTS, 'core-signals-'));
  const marker = path.join(dir, 'disposed');
  const program = path.join(dir, 'program.ts');
  writeFileSync(program, `
import { writeFileSync } from 'node:fs';
import { launch } from 'e2e-core';
import { createFakeEngine, FAKE_APP } from ${JSON.stringify(FAKE_ENGINE)};

const fake = createFakeEngine({
  onDispose: () => writeFileSync(${JSON.stringify(marker)}, 'disposed'),
  ${failClose ? "onEndAttempt: () => { throw new Error('the device would not let go'); }," : ''}
});
const host = await launch(fake.engine, { app: FAKE_APP, cwd: ${JSON.stringify(dir)}, env: {} });
await host.newSession();
process.stdout.write('READY\\n');
setInterval(() => undefined, 1_000);
`);
  // Run from the package, so the program resolves e2e-core the way the tests do.
  const child = spawn(process.execPath, [program], { cwd: path.join(import.meta.dirname, '..', '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('READY')) resolve(); });
    child.once('exit', () => reject(new Error(`the program exited before it was ready:\n${stderr}`)));
  });
  child.kill('SIGINT');
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal])));
  return { code, signal, stderr, disposed: existsSync(marker) };
}

describe('e2e-core on SIGINT', { timeout: 60_000 }, () => {
  it('closes the host, disposing its engine, then ends by the signal', async () => {
    const ended = await interrupt(false);
    expect(ended, ended.stderr).toMatchObject({ signal: 'SIGINT', disposed: true });
    expect(ended.stderr).not.toContain('failed');
  });

  it('says on stderr that a close failed, and still ends by the signal', async () => {
    const ended = await interrupt(true);
    expect(ended.signal).toBe('SIGINT');
    expect(ended.stderr).toContain('e2e-core: closing a host on SIGINT failed');
  });
});
