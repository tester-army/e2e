/**
 * The app half of `open_session`'s summary: where the app is, the port the
 * session assigned, and the process it brought up for it, so an agent never
 * reads the config to learn what is listening. Nothing that may carry a
 * secret is printed: `args` are left out, `env` and `inheritEnv` are named
 * without values, and the readiness URL loses userinfo and query.
 */

import type { ResolvedTarget } from '../config/resolve.ts';
import { launchesPinnedApp } from '../config/targets.ts';
import { printableUrl } from '../internal/urls.ts';
import type { CommandConfig } from '../types.ts';

/**
 * The `App:` and `Process:` lines for a session on `target`. `ranTest` is
 * whether the session ran a test first, which launched a pinned app itself.
 */
export function appLines(target: ResolvedTarget, ranTest: boolean): string[] {
  const { app } = target;
  const lines: string[] = [];
  if (app.base !== undefined) {
    const assigned = app.portRequest?.port;
    lines.push(`App: ${app.base.href}${assigned === undefined ? '' : ` (port ${assigned}, assigned for the declared port 0)`}.`);
  } else if (launchesPinnedApp(target)) {
    const pinned = app.bundleId ?? app.appPath;
    lines.push(ranTest ? `App: ${pinned}.` : `App: ${pinned}, launched fresh.`);
  }
  if (app.command !== undefined && app.readyUrl !== undefined) {
    lines.push(`Process: ${describeCommand(app.command, app.readyUrl)} e2e starts no other app process for this session; a database or other service the app uses runs outside e2e.`);
  } else if (app.base !== undefined) {
    lines.push('Process: none; the target declares no app.command, so the app runs outside e2e.');
  }
  return lines;
}

/** One app command as the session ran it: its executable, where it answers, and what it was given. */
function describeCommand(command: CommandConfig, readyUrl: string): string {
  const facts = [`ready at ${printableUrl(readyUrl)}`];
  if (command.reuseExisting === true) facts.push('reuseExisting: a server already answering there is used instead of starting one');
  const env = Object.keys(command.env ?? {});
  if (env.length > 0) facts.push(`env ${env.join(', ')}`);
  if (command.inheritEnv !== undefined && command.inheritEnv.length > 0) facts.push(`inherits ${command.inheritEnv.join(', ')}`);
  if (command.cwd !== undefined) facts.push(`cwd ${command.cwd}`);
  if (command.log !== undefined) facts.push(`log ${command.log}`);
  return `app.command ${JSON.stringify(command.executable)} (${facts.join('; ')}).`;
}
