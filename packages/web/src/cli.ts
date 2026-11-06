/** The `e2e-web` command: installs the browser builds this engine pins, and the ffmpeg that records Chromium video. */

import os from 'node:os';
import { BROWSER_NAMES, isBrowserName, type BrowserName } from './browsers.ts';
import { ensureFfmpeg } from './install/ffmpeg.ts';
import { installBrowsers } from './install/provision.ts';

/** What `e2e-web install` installs: a browser, or ffmpeg. */
export type InstallName = BrowserName | 'ffmpeg';

const INSTALL_NAMES: readonly InstallName[] = [...BROWSER_NAMES, 'ffmpeg'];

const INSTALL_ARGS = `[${INSTALL_NAMES.join('|')} ...] [--with-deps] [--headed]`;

const USAGE = `Usage: npx @e2e-dev/web install ${INSTALL_ARGS}
       bunx @e2e-dev/web install ${INSTALL_ARGS}
       pnpm exec e2e-web install ${INSTALL_ARGS}

Installs the browser builds @e2e-dev/web runs into E2E_BROWSERS_PATH, else
the user cache. Installs chromium when nothing is named. ffmpeg records
chromium video; a recording downloads it when it is missing. --headed
installs the full chromium build a headed run launches instead of the
headless shell. --with-deps also installs the system libraries the browsers
need on Debian and Ubuntu.
`;

/** What `main` writes to and spawns; tests replace them. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly run: (names: readonly InstallName[], options: { readonly withDeps: boolean; readonly headed: boolean }) => Promise<number>;
}

const PROCESS_IO: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  run: runInstall,
};

/** Whether `name` is something `e2e-web install` installs. */
function isInstallName(name: string): name is InstallName {
  return (INSTALL_NAMES as readonly string[]).includes(name);
}

/** Runs `e2e-web` with the arguments after the command name and resolves to the exit code. */
export async function main(args: readonly string[], io: CliIo = PROCESS_IO): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'help' || args.some((arg) => arg === '--help' || arg === '-h')) {
    io.stdout(USAGE);
    return 0;
  }
  if (command !== 'install') {
    io.stderr(`${command === undefined ? 'missing command' : `unknown command "${command}"`}\n\n${USAGE}`);
    return 2;
  }
  const options = rest.filter((arg) => arg.startsWith('-'));
  const names = rest.filter((arg) => !arg.startsWith('-'));
  const unknownOption = options.find((option) => option !== '--with-deps' && option !== '--headed');
  if (unknownOption !== undefined) {
    io.stderr(`unknown option "${unknownOption}"\n\n${USAGE}`);
    return 2;
  }
  const unknownName = names.find((name) => !isInstallName(name));
  if (unknownName !== undefined) {
    io.stderr(`unknown browser "${unknownName}"; expected one of ${INSTALL_NAMES.join(', ')}\n`);
    return 2;
  }
  const installs = (names.length > 0 ? names : ['chromium']) as InstallName[];
  return io.run(installs, { withDeps: options.includes('--with-deps'), headed: options.includes('--headed') });
}

/**
 * Installs `names`, narrating to stderr; resolves to the exit code. SIGINT
 * or SIGTERM aborts the download, the partial files are removed, and the
 * exit code is the signal's, 130 or 143.
 */
async function runInstall(names: readonly InstallName[], { withDeps, headed }: { readonly withDeps: boolean; readonly headed: boolean }): Promise<number> {
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const controller = new AbortController();
  let signalCode: number | undefined;
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const handler = () => {
      signalCode = 128 + os.constants.signals[signal];
      controller.abort();
    };
    process.once(signal, handler);
    return () => process.off(signal, handler);
  });
  try {
    const browsers = names.filter(isBrowserName);
    if (browsers.length > 0 || withDeps) await installBrowsers(browsers, { log, signal: controller.signal, env: process.env, headed, withDeps });
    if (names.includes('ffmpeg')) log(`ffmpeg: ${await ensureFfmpeg(process.env, { log, signal: controller.signal })}`);
    return signalCode ?? 0;
  } catch (cause) {
    if (signalCode !== undefined) return signalCode;
    log(cause instanceof Error ? cause.message : String(cause));
    return 1;
  } finally {
    for (const remove of handlers) remove();
  }
}
