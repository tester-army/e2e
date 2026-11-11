import { execFile, fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DriverGrant, DriverRequest } from './driver.ts';

const exec = promisify(execFile);

/** A property of a parsed JSON value, or undefined when the value is not an object. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/** The installed agent-device CLI entry, resolved from its package without importing it. */
function agentDeviceBin(): string {
  let directory = path.dirname(fileURLToPath(import.meta.resolve('agent-device')));
  while (true) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    } catch { /* The entry may be several directories below its package. */ }
    if (field(manifest, 'name') === 'agent-device') {
      const bin = field(field(manifest, 'bin'), 'agent-device');
      if (typeof bin !== 'string') throw new Error('The installed agent-device package has no agent-device bin');
      return path.join(directory, bin);
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot find the installed agent-device package');
    directory = parent;
  }
}

/**
 * Allocates a lease from a fresh daemon in a separate process, so each daemon
 * gets its own credentials and home without changing the runner's environment.
 * Not cancellable: an interrupted allocation can still grant a lease, which
 * the caller then releases.
 */
export async function startDriver(request: DriverRequest, env: NodeJS.ProcessEnv, label: string): Promise<DriverGrant> {
  const entry = new URL(import.meta.url.endsWith('.ts') ? './driver.ts' : './driver.js', import.meta.url);
  return new Promise((resolve, reject) => {
    const child = fork(entry, [], { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let answered = false;
    child.once('error', reject);
    child.once('message', (reply: { grant?: DriverGrant; error?: string }) => {
      answered = true;
      if (reply.grant) resolve(reply.grant);
      else reject(new Error(reply.error ?? `${label} driver returned no lease`));
    });
    child.once('exit', () => {
      if (!answered) reject(new Error(`${label} driver exited before allocation finished`));
    });
    child.send(request);
  });
}

/**
 * Stops the daemon, which releases its leases and so ends their sessions at
 * the service, and throws unless it confirms they ended. `leaseId` is the
 * lease the daemon granted, when it granted one.
 */
export async function stopDriver(stateDir: string, env: NodeJS.ProcessEnv, leaseId: string | undefined, label: string, signal: AbortSignal): Promise<void> {
  const { stdout } = await exec(process.execPath, [agentDeviceBin(), 'daemon', 'stop', '--state-dir', stateDir, '--clean', '--json'], { env, signal });
  assertSessionsEnded(stdout, leaseId, label);
}

/**
 * Throws unless `daemon stop --json` reports every session ended.
 * A forced stop or a lost shutdown report comes back as `status: 'unknown'`
 * with `pending: null`: the session may still be running, and billed.
 *
 * A granted lease also needs the report to list it as released. A daemon
 * that is not running reports nothing pending (`mode: 'not-running'`), and so
 * does one started after the granting daemon died, while the session may
 * still be open. Without `leaseId`, before anything was granted, such a
 * report means there is nothing to release.
 */
export function assertSessionsEnded(stdout: string, leaseId: string | undefined, label: string): void {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`agent-device stopped without a readable shutdown report; ${label} sessions may still be running`);
  }
  const data = field(report, 'data');
  const releases = field(data, 'providerReleases');
  const pending = field(releases, 'pending');
  if (Array.isArray(pending) && pending.length > 0) throw new Error(`agent-device stopped without ending ${pending.length} ${label} session(s)`);
  if (field(releases, 'status') !== 'completed' || !Array.isArray(pending)) {
    const warnings = field(data, 'warnings');
    const detail = Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === 'string').join(' ') : '';
    throw new Error(`agent-device could not confirm its ${label} sessions ended${detail === '' ? '' : `: ${detail}`}`);
  }
  if (leaseId === undefined) return;
  const released = field(releases, 'released');
  if (Array.isArray(released) && released.some((entry) => field(entry, 'leaseId') === leaseId)) return;
  const what = field(data, 'mode') === 'not-running' ? `found no daemon running for lease ${leaseId}` : `stopped without listing lease ${leaseId} as released`;
  throw new Error(`agent-device ${what}, so nothing confirms its ${label} session ended`);
}
