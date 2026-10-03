/** The `e2e-web` command: browser installs with the Playwright version this engine pins. */

import { BROWSER_NAMES, isBrowserName } from './browser-connection.ts';
import { runPlaywrightCli } from './install.ts';

const BROWSER_ARGS = `[${BROWSER_NAMES.join('|')} ...] [--with-deps]`;

const USAGE = `Usage: npx @e2e-dev/web install ${BROWSER_ARGS}
       bunx @e2e-dev/web install ${BROWSER_ARGS}
       pnpm exec e2e-web install ${BROWSER_ARGS}

Installs browsers for the Playwright version @e2e-dev/web runs. Installs
chromium when no browser is named. --with-deps also installs the system
libraries the browsers need on Linux.
`;

/** What `main` writes to and spawns; tests replace them. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly run: (args: readonly string[]) => Promise<number>;
}

const PROCESS_IO: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  run: runPlaywrightCli,
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
  const unknownOption = options.find((option) => option !== '--with-deps');
  if (unknownOption !== undefined) {
    io.stderr(`unknown option "${unknownOption}"\n\n${USAGE}`);
    return 2;
  }
  const unknownBrowser = names.find((name) => !isBrowserName(name));
  if (unknownBrowser !== undefined) {
    io.stderr(`unknown browser "${unknownBrowser}"; expected one of ${BROWSER_NAMES.join(', ')}\n`);
    return 2;
  }
  return io.run(['install', ...options, ...(names.length > 0 ? names : ['chromium'])]);
}
