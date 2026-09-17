/**
 * The terminal side of a login: `login <provider>`, `logout <provider>`,
 * `status`. The e2e CLI forwards its `login` and `logout` commands here; the
 * package's own `e2e-oauth` bin calls it directly.
 */

import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import * as clack from '@clack/prompts';
import { OAuthError } from './errors.ts';
import { login, logout, status } from './login.ts';
import { PROVIDER_IDS, getProvider, isBuiltInProviderId } from './registry.ts';
import type { OAuthLoginCallbacks } from './types.ts';

export interface CliIo {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTTY: boolean;
  /** Opens a URL in the user's browser; the default spawns the platform opener. */
  readonly openUrl?: (url: string) => void;
}

const USAGE = `Usage:
  e2e-oauth login <provider> [--device] [--client-id <id>] [--from-gh] [--enterprise-url <host>]
  e2e-oauth logout <provider>
  e2e-oauth status

Providers: ${PROVIDER_IDS.join(', ')}
  openai-codex    ChatGPT Plus/Pro (the Codex sign-in); --device for a machine without a browser
  github-copilot  GitHub Copilot: the GitHub CLI's token when gh is signed in, or a device flow with --client-id
  xai             SuperGrok / X Premium+ (device code)
`;

export async function runOAuthCli(argv: readonly string[], io: CliIo = defaultIo()): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      device: { type: 'boolean' },
      'client-id': { type: 'string' },
      'from-gh': { type: 'boolean' },
      'enterprise-url': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, providerId] = positionals;
  if (values.help === true || command === undefined) {
    io.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }
  try {
    switch (command) {
      case 'login':
        return await runLogin(requireProvider(providerId), values, io);
      case 'logout': {
        const had = await logout(requireProvider(providerId));
        io.stdout.write(had ? `Signed out of ${providerId}.\n` : `No ${providerId} login was stored.\n`);
        return 0;
      }
      case 'status': {
        const entries = await status();
        if (entries.length === 0) {
          io.stdout.write(`No logins stored. ${USAGE}`);
          return 0;
        }
        for (const entry of entries) io.stdout.write(`${entry.id.padEnd(16)} ${entry.name.padEnd(16)} ${describeExpiry(entry.expires)}\n`);
        return 0;
      }
      default:
        io.stderr.write(`Unknown command ${command}.\n${USAGE}`);
        return 1;
    }
  } catch (cause) {
    io.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return cause instanceof OAuthError && cause.code === 'CANCELLED' ? 130 : 1;
  }
}

function requireProvider(id: string | undefined): string {
  if (id === undefined || !isBuiltInProviderId(id)) {
    throw new OAuthError('MISCONFIGURED', `name a provider: ${PROVIDER_IDS.join(', ')}`);
  }
  return id;
}

function describeExpiry(expires: number | undefined): string {
  if (expires === undefined) return 'not signed in';
  if (expires === 0) return 'signed in';
  return expires <= Date.now() ? 'signed in, token expired (refreshes on the next call)' : `signed in, token valid until ${new Date(expires).toLocaleString()}`;
}

async function runLogin(
  providerId: string,
  values: { device?: boolean; 'client-id'?: string; 'from-gh'?: boolean; 'enterprise-url'?: string },
  io: CliIo,
): Promise<number> {
  const provider = getProvider(providerId)!;
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  const spinner = io.isTTY ? clack.spinner() : undefined;
  clack.intro(`Sign in to ${provider.name}`);
  const callbacks: OAuthLoginCallbacks = {
    signal: controller.signal,
    onAuth(info) {
      if (info.userCode !== undefined) clack.note(`${info.url}\n\nCode: ${info.userCode}`, 'Open this page and enter the code');
      else clack.note(info.url, 'Open this page');
      io.stdout.write(`${info.instructions}\n`);
      (io.openUrl ?? openInBrowser)(info.url);
      spinner?.start('Waiting for the sign-in to finish');
    },
    onProgress(message) {
      if (spinner === undefined) io.stdout.write(`${message}\n`);
      else spinner.message(message);
    },
    async onPrompt(prompt) {
      spinner?.stop('Waiting for your input');
      if (!io.isTTY) throw new OAuthError('FLOW_FAILED', `${prompt.message}: this terminal is not interactive, so nothing can be pasted; use --device or run from a terminal`);
      const answer = await clack.text({ message: prompt.message, ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }) });
      if (clack.isCancel(answer)) throw new OAuthError('CANCELLED', 'the login was cancelled');
      spinner?.start('Finishing the sign-in');
      return answer as string;
    },
  };
  try {
    const options = {
      ...(values.device === true ? { method: 'device' as const } : {}),
      ...(values['client-id'] === undefined ? {} : { clientId: values['client-id'] }),
      ...(values['from-gh'] === true ? { fromGitHubCli: true } : {}),
      ...(values['enterprise-url'] === undefined ? {} : { enterpriseUrl: values['enterprise-url'] }),
    };
    const credentials = await login(providerId, { callbacks, options });
    spinner?.stop('Signed in');
    clack.outro(`${provider.name} login stored${credentials.expires === 0 ? '' : `; the token refreshes itself`}.`);
    return 0;
  } catch (cause) {
    spinner?.stop('Sign-in failed');
    throw cause;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function defaultIo(): CliIo {
  return { stdout: process.stdout, stderr: process.stderr, isTTY: process.stdout.isTTY === true && process.stdin.isTTY === true };
}

/** Best effort: the URL is printed regardless, so a failure to open a browser is not an error. */
function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url.replaceAll('&', '^&')]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Printed URL is the fallback.
  }
}
