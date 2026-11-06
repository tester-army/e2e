/**
 * The process a launched browser lives under, which ties its lifetime to the
 * worker that launched it. The worker spawns this with a stdin pipe; this
 * spawns the browser, in the same process group, and passes its stderr
 * through for the endpoint line. When stdin closes, because the worker
 * closed the browser, exited, or was killed (even with SIGKILL, which runs
 * no exit hook), the browser is killed. Whichever way the browser exits, its
 * profile directory is removed before this exits.
 */

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The watchdog's arguments: the profile it removes, then the browser's executable and arguments. */
export function watchdogArgs(profile: string, executable: string, args: readonly string[]): string[] {
  return [profile, executable, ...args];
}

/** Runs the browser `argv` names until it exits or stdin closes, then removes its profile and exits with its code. */
function watch(argv: readonly string[]): void {
  const [profile, executable, ...args] = argv;
  if (profile === undefined || executable === undefined) {
    process.stderr.write('browser watchdog: expected a profile directory and an executable\n');
    process.exit(2);
  }
  const browser = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  const finish = (code: number): never => {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    process.exit(code);
  };
  browser.once('error', (cause) => {
    process.stderr.write(`browser watchdog: could not start ${executable}: ${cause.message}\n`);
    finish(1);
  });
  browser.once('exit', (code) => finish(code ?? 1));
  const kill = (): void => {
    if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGKILL');
  };
  process.stdin.once('close', kill);
  process.stdin.once('end', kill);
  process.stdin.on('error', kill);
  process.stdin.resume();
  process.on('SIGTERM', kill);
  // An interrupt reaches the browser itself through the process group; this stays to remove the profile once it exits.
  process.on('SIGINT', () => undefined);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) watch(process.argv.slice(2));
