/** The `e2e-web` command: installs the browser builds this engine pins. */

import { BROWSER_NAMES, isBrowserName, type BrowserName } from './browser-names.ts';
import { installBrowsers, installFfmpeg } from './install.ts';

const BROWSER_ARGS = `[${BROWSER_NAMES.join('|')} ...] [--with-deps] [--headed]`;

const USAGE = `Usage: npx @e2e-dev/web install ${BROWSER_ARGS}
       bunx @e2e-dev/web install ${BROWSER_ARGS}
       pnpm exec e2e-web install ${BROWSER_ARGS}

Installs the browser builds @e2e-dev/web runs into E2E_BROWSERS_PATH, else
the user cache. Installs chromium when no browser is named; chromium brings
the ffmpeg that records its video. --headed installs the full chromium build
a headed run launches. --with-deps also installs the system libraries the
browsers need on Debian and Ubuntu.
`;

/** What `main` writes to and spawns; tests replace them. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly run: (names: readonly BrowserName[], options: { readonly withDeps: boolean; readonly headed: boolean }) => Promise<number>;
}

const PROCESS_IO: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  run: runInstall,
};

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
  const unknownBrowser = names.find((name) => !isBrowserName(name));
  if (unknownBrowser !== undefined) {
    io.stderr(`unknown browser "${unknownBrowser}"; expected one of ${BROWSER_NAMES.join(', ')}\n`);
    return 2;
  }
  const browsers = (names.length > 0 ? names : ['chromium']) as BrowserName[];
  return io.run(browsers, { withDeps: options.includes('--with-deps'), headed: options.includes('--headed') });
}

/** Installs `names` (and ffmpeg with chromium), narrating to stderr; resolves to the exit code. */
async function runInstall(names: readonly BrowserName[], { withDeps, headed }: { readonly withDeps: boolean; readonly headed: boolean }): Promise<number> {
  const log = (line: string) => process.stderr.write(`${line}\n`);
  try {
    await installBrowsers(names, { log, env: process.env, headed, withDeps });
    if (names.includes('chromium')) await installFfmpeg({ log, env: process.env });
    return 0;
  } catch (cause) {
    log(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}
