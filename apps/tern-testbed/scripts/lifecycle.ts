import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sway } from '@e2e-dev/sway';
import type { TernRequest, TernLease } from '@e2e-dev/tern';
import { nativeOptions } from '../native-options.ts';

const childMode = process.argv[2] === 'worker';
const workerSignal=process.env.E2E_NATIVE_WORKER_SIGNAL??'SIGKILL';
assert(['SIGKILL','SIGTERM','SIGINT'].includes(workerSignal),'only explicit worker termination fixtures are allowed');
const directory = childMode ? process.env.E2E_NATIVE_ROOT! : await mkdtemp(join(tmpdir(), 'e2e-lc-'));
const runId = childMode ? process.env.E2E_NATIVE_RUN! : randomUUID();
const provider = sway({ ...nativeOptions(), root: directory });
const artifactsDir = join(directory, 'artifacts');
await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
const request: TernRequest = { runId, targetName: 'lifecycle', attemptId: 'worker-death', workerSlot: 0,
  projectRoot: fileURLToPath(new URL('..', import.meta.url)), app: { appPath: process.execPath, launchArguments: [fileURLToPath(new URL('../src/controls.mjs', import.meta.url))] },
  env: { PATH: process.env.PATH }, artifactsDir, signal: AbortSignal.timeout(90000) };
if (childMode) {
  const lease = await provider.acquire(request);
  console.log(JSON.stringify({ id: lease.id, client: lease.client }));
  setInterval(() => {}, 1000); // The real worker keeps the real lease until this fixture kills it.
} else {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', E2E_NATIVE_ROOT: directory, E2E_NATIVE_RUN: runId };
  for (const key of ['E2E_SWAY_BINARY', 'E2E_SWAYMSG_BINARY', 'E2E_GRIM_BINARY', 'E2E_TERN_BINARY', 'E2E_INPUT_BINARY']) env[key] = process.env[key]!;
  const worker = fork(fileURLToPath(import.meta.url), ['worker'], { env, stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  const cleanup = { signal: AbortSignal.timeout(30000), timeoutMs: 30000 };
  let receipt: Pick<TernLease, 'id' | 'client'> | undefined;
  try {
    receipt = await new Promise((accept, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('Real worker acquisition did not report readiness')), 90000);
      worker.stdout!.on('data', value => { text += value.toString(); if (text.includes('\n')) { clearTimeout(timer); try { accept(JSON.parse(text.trim()) as Pick<TernLease, 'id' | 'client'>); } catch (error) { reject(error); } } });
      worker.once('error', reject);
      worker.once('exit', code => { clearTimeout(timer); reject(new Error(`Worker exited before readiness: ${code}`)); });
    });
    assert(receipt.client);
    const exited = once(worker, 'exit'); worker.kill(workerSignal as NodeJS.Signals); await exited;
    const before = await readFile(`/proc/${receipt.client.pid}/stat`, 'utf8');
    assert.equal(before.slice(before.lastIndexOf(')') + 2).split(' ')[19], receipt.client.start, 'native client survives worker death');
    await provider.sweep!({ runId, targetName: request.targetName, env: request.env }, cleanup);
    await assert.rejects(lstat(receipt.id), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
    try {
      const after = await readFile(`/proc/${receipt.client.pid}/stat`, 'utf8');
      assert.notEqual(after.slice(after.lastIndexOf(')') + 2).split(' ')[19], receipt.client.start, 'owned native client was cleaned, not merely forgotten');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    console.log('Real worker-death sweep: native client and owned sockets removed');
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) { const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited; }
    await provider.sweep!({ runId, targetName: request.targetName, env: request.env }, { signal: AbortSignal.timeout(30000), timeoutMs: 30000 });
    await rm(directory, { recursive: true });
  }
}
