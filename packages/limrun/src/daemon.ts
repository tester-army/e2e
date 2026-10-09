import { execFile, fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DriverBinding, DriverRequest } from './driver.ts';

const exec = promisify(execFile);

/** Resolve the package's declared CLI, without importing its private daemon entry. */
function installation(): { version: string; bin: string } {
  let directory = path.dirname(fileURLToPath(import.meta.resolve('agent-device')));
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as { name?: string; version: string; bin: Record<string, string> };
      if (manifest.name === 'agent-device') return { version: manifest.version, bin: path.join(directory, manifest.bin['agent-device']!) };
    } catch { /* The entry may be several directories below its package. */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot find the installed agent-device CLI');
    directory = parent;
  }
}

export function assertDriverVersion(expected: string): void {
  const actual = installation().version;
  if (actual !== expected) throw new Error(`@e2e-dev/limrun uses agent-device ${actual}, but @e2e-dev/mobile uses ${expected}. Install matching versions.`);
}

export async function assertAndroidTools(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  try {
    await exec('adb', ['version'], { env, signal });
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    throw new Error('Limrun Android requires the Android SDK Platform-Tools adb executable on PATH. The device still runs in Limrun.', { cause });
  }
}

export async function startDriver(request: DriverRequest, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<DriverBinding> {
  signal.throwIfAborted();
  const entry = new URL(import.meta.url.endsWith('.ts') ? './driver.ts' : './driver.js', import.meta.url);
  return new Promise((resolve, reject) => {
    const child = fork(entry, [], { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    let answered = false;
    child.once('error', reject);
    child.once('message', (reply: { binding?: DriverBinding; error?: string }) => {
      answered = true;
      if (reply.binding) resolve(reply.binding);
      else reject(new Error(reply.error ?? 'Limrun driver returned no binding'));
    });
    child.once('exit', () => {
      signal.removeEventListener('abort', abort);
      if (!answered) reject(signal.aborted ? signal.reason : new Error('Limrun driver exited before allocation finished'));
    });
    child.send(request);
  });
}

export async function stopDriver(stateDir: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  await exec(process.execPath, [installation().bin, 'daemon', 'stop', '--state-dir', stateDir, '--clean', '--json'], { env, signal });
}
