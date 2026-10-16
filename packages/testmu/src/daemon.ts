import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DriverGrant, DriverRequest } from './driver.ts';

const exec = promisify(execFile);

const PLUGIN = '@agent-device/testmu';

interface Installation {
  directory: string;
  version: string;
  bin: unknown;
}

/** A property of a parsed JSON value, or undefined when the value is not an object. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/** Resolve a dependency's package directory from its entry, without importing it. */
function installation(name: string): Installation {
  let directory = path.dirname(fileURLToPath(import.meta.resolve(name)));
  while (true) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      const version = field(manifest, 'version');
      if (field(manifest, 'name') === name && typeof version === 'string') return { directory, version, bin: field(manifest, 'bin') };
    } catch { /* The entry may be several directories below its package. */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot find the installed ${name} package`);
    directory = parent;
  }
}

export function assertDriverVersion(expected: string): void {
  const actual = installation('agent-device').version;
  if (actual !== expected) throw new Error(`@e2e-dev/testmu uses agent-device ${actual}, but @e2e-dev/mobile uses ${expected}. Install matching versions.`);
}

/**
 * Registers the installed `@agent-device/testmu` in a private agent-device
 * home, the layout `agent-device plugins add` writes, without fetching it
 * from the registry again.
 */
export async function installPlugin(home: string): Promise<void> {
  const plugin = installation(PLUGIN);
  const id = randomUUID();
  const scope = path.join(home, 'plugins', id, 'node_modules', '@agent-device');
  await mkdir(scope, { recursive: true, mode: 0o700 });
  await symlink(plugin.directory, path.join(scope, 'testmu'), 'junction');
  await writeFile(path.join(home, 'config.json'), `${JSON.stringify({ plugins: { [PLUGIN]: { installation: id, version: plugin.version } } })}\n`, { mode: 0o600 });
}

/** Not cancellable: an interrupted allocation can still grant a lease, which the caller then releases. */
export async function startDriver(request: DriverRequest, env: NodeJS.ProcessEnv): Promise<DriverGrant> {
  const entry = new URL(import.meta.url.endsWith('.ts') ? './driver.ts' : './driver.js', import.meta.url);
  return new Promise((resolve, reject) => {
    const child = fork(entry, [], { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let answered = false;
    child.once('error', reject);
    child.once('message', (reply: { grant?: DriverGrant; error?: string }) => {
      answered = true;
      if (reply.grant) resolve(reply.grant);
      else reject(new Error(reply.error ?? 'TestMu AI driver returned no lease'));
    });
    child.once('exit', () => {
      if (!answered) reject(new Error('TestMu AI driver exited before allocation finished'));
    });
    child.send(request);
  });
}

/** Stopping the daemon releases its leases, which ends their TestMu AI sessions. */
export async function stopDriver(stateDir: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const cli = installation('agent-device');
  const bin = field(cli.bin, 'agent-device');
  if (typeof bin !== 'string') throw new Error('The installed agent-device package has no agent-device bin');
  const { stdout } = await exec(process.execPath, [path.join(cli.directory, bin), 'daemon', 'stop', '--state-dir', stateDir, '--clean', '--json'], { env, signal });
  const pending = field(field(field(JSON.parse(stdout), 'data'), 'providerReleases'), 'pending');
  if (Array.isArray(pending) && pending.length > 0) throw new Error(`agent-device stopped without ending ${pending.length} TestMu AI session(s)`);
}
