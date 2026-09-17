/**
 * The terminal side of a login. `runLogin`, `runLogout`, and `runStatus` are
 * what the e2e CLI calls; `runOAuthCli` parses argv for the package's own
 * `e2e-oauth` bin and dispatches to them.
 */

import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import * as clack from '@clack/prompts';
import { OAuthError } from './errors.ts';
import { login, logout } from './login.ts';
import { PROVIDER_IDS, getProvider, isProviderId, type LoginOptionsById, type ProviderId } from './providers.ts';
import { defaultCredentialStore } from './store.ts';
import type { OAuthLoginCallbacks } from './types.ts';

export interface CliIo {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTTY: boolean;
  /** Opens a URL in the user's browser; the default spawns the platform opener. */
  readonly openUrl?: (url: string) => void;
}

/** The flags every login takes, as the e2e CLI and the bin hand them over. */
export interface LoginFlags {
  readonly method?: 'device';
  readonly clientId?: string;
  readonly fromGitHubCli?: boolean;
  readonly enterpriseUrl?: string;
}

const USAGE = `Usage:
  e2e-oauth login [provider] [--device] [--client-id <id>] [--from-gh] [--enterprise-url <host>]
  e2e-oauth logout [provider]
  e2e-oauth status

Without a provider, login and logout show a picker.

Providers: ${PROVIDER_IDS.join(', ')}
  openai          ChatGPT Plus/Pro (the Codex sign-in); --device for a machine without a browser
  github-copilot  GitHub Copilot: the GitHub CLI's token when gh is signed in, or a device flow with --client-id
  spacexai        SuperGrok / X Premium+ (device code)
`;

/** Signs in to `providerId`; without one, a picker over the providers, marking those already signed in. */
export async function runLogin(providerId: string | undefined, flags: LoginFlags, io: CliIo = defaultIo()): Promise<number> {
  return report(io, async () => {
    const id = providerId === undefined || providerId === '' ? await pickProvider(io, 'Which subscription do you want to sign in to?', await signedIn()) : requireProvider(providerId);
    const provider = getProvider(id);
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once('SIGINT', onSigint);
    const ui = terminalCallbacks(provider.name, io, controller.signal);
    try {
      const credentials = await login(id, { callbacks: ui.callbacks, options: toLoginOptions(id, flags) });
      ui.done(`${provider.name} login stored${credentials.expires === 0 ? '' : '; the token refreshes itself'}.`);
    } catch (cause) {
      ui.failed();
      throw cause;
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
  });
}

/** Forgets the login of `providerId`; without one, a picker over the stored logins. */
export async function runLogout(providerId: string | undefined, io: CliIo = defaultIo()): Promise<number> {
  return report(io, async () => {
    let id: ProviderId;
    if (providerId === undefined || providerId === '') {
      const stored = await signedIn();
      if (stored.size === 0) {
        io.stdout.write('No logins stored.\n');
        return;
      }
      id = await pickProvider(io, 'Which login do you want to forget?', stored, [...stored.keys()]);
    } else {
      id = requireProvider(providerId);
    }
    const had = await logout(id);
    io.stdout.write(had ? `Signed out of ${id}.\n` : `No ${id} login was stored.\n`);
  });
}

/** The providers with a stored login, and how each one stands. */
async function signedIn(): Promise<Map<ProviderId, string>> {
  const store = defaultCredentialStore();
  const out = new Map<ProviderId, string>();
  for (const id of await store.list()) {
    if (!isProviderId(id)) continue;
    out.set(id, describeExpiry((await store.get(id))?.expires));
  }
  return out;
}

const PROVIDER_HINTS: Record<ProviderId, string> = {
  openai: 'ChatGPT Plus/Pro, the Codex sign-in',
  'github-copilot': 'GitHub Copilot: OpenAI, Anthropic, Google, and xAI models',
  spacexai: 'SuperGrok or X Premium+',
};

/** A terminal picker over providers; without a terminal the provider has to be named. */
async function pickProvider(io: CliIo, message: string, stored: Map<ProviderId, string>, ids: readonly ProviderId[] = PROVIDER_IDS): Promise<ProviderId> {
  if (!io.isTTY) throw new OAuthError('MISCONFIGURED', `name a provider: ${ids.join(', ')}`);
  const choice = await clack.select<ProviderId>({
    message,
    options: ids.map((id) => ({ value: id, label: getProvider(id).name, hint: stored.has(id) ? `${stored.get(id)}; ${PROVIDER_HINTS[id]}` : PROVIDER_HINTS[id] })),
  });
  if (clack.isCancel(choice)) throw new OAuthError('CANCELLED', 'the login was cancelled');
  return choice as ProviderId;
}

export async function runStatus(io: CliIo = defaultIo()): Promise<number> {
  return report(io, async () => {
    const store = defaultCredentialStore();
    const ids = await store.list();
    if (ids.length === 0) {
      io.stdout.write(`No logins stored. Sign in with one of: ${PROVIDER_IDS.map((id) => `e2e login ${id}`).join(', ')}.\n`);
      return;
    }
    for (const id of ids) {
      const credentials = await store.get(id);
      const name = isProviderId(id) ? getProvider(id).name : id;
      io.stdout.write(`${id.padEnd(16)} ${name.padEnd(16)} ${describeExpiry(credentials?.expires)}\n`);
    }
  });
}

/** The `e2e-oauth` bin: argv in, exit code out. */
export async function runOAuthCli(argv: readonly string[], io: CliIo = defaultIo()): Promise<number> {
  return report(io, async () => {
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
    switch (command) {
      case 'login':
        return runLogin(
          providerId,
          {
            ...(values.device === true ? { method: 'device' as const } : {}),
            ...(values['client-id'] === undefined ? {} : { clientId: values['client-id'] }),
            ...(values['from-gh'] === true ? { fromGitHubCli: true } : {}),
            ...(values['enterprise-url'] === undefined ? {} : { enterpriseUrl: values['enterprise-url'] }),
          },
          io,
        );
      case 'logout':
        return runLogout(providerId, io);
      case 'status':
        return runStatus(io);
      default:
        throw new OAuthError('MISCONFIGURED', `Unknown command ${command}.\n${USAGE}`);
    }
  });
}

/** Runs a command, printing a failure as one line; cancellation exits like an interrupt. */
async function report(io: CliIo, run: () => Promise<number | undefined>): Promise<number> {
  try {
    return (await run()) ?? 0;
  } catch (cause) {
    io.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return cause instanceof OAuthError && cause.code === 'CANCELLED' ? 130 : 1;
  }
}

function requireProvider(id: string): ProviderId {
  if (!isProviderId(id)) throw new OAuthError('MISCONFIGURED', `name a provider: ${PROVIDER_IDS.join(', ')}`);
  return id;
}

/** The provider's own login options from the shared flags; flags meant for another provider are ignored. */
function toLoginOptions<Id extends ProviderId>(id: Id, flags: LoginFlags): LoginOptionsById[Id] {
  switch (id) {
    case 'openai':
      return (flags.method === undefined ? {} : { method: flags.method }) as LoginOptionsById[Id];
    case 'github-copilot':
      return {
        ...(flags.clientId === undefined ? {} : { clientId: flags.clientId }),
        ...(flags.fromGitHubCli === true ? { fromGitHubCli: true } : {}),
        ...(flags.enterpriseUrl === undefined ? {} : { enterpriseUrl: flags.enterpriseUrl }),
      } as LoginOptionsById[Id];
    default:
      return {} as LoginOptionsById[Id];
  }
}

function describeExpiry(expires: number | undefined): string {
  if (expires === undefined) return 'not signed in';
  if (expires === 0) return 'signed in';
  return expires <= Date.now() ? 'signed in, token expired (refreshes on the next call)' : `signed in, token valid until ${new Date(expires).toLocaleString()}`;
}

/** Clack prompts around a login flow; plain lines when there is no terminal. */
function terminalCallbacks(providerName: string, io: CliIo, signal: AbortSignal) {
  const spinner = io.isTTY ? clack.spinner() : undefined;
  if (io.isTTY) clack.intro(`Sign in to ${providerName}`);
  else io.stdout.write(`Sign in to ${providerName}\n`);
  const callbacks: OAuthLoginCallbacks = {
    signal,
    onAuth(info) {
      if (io.isTTY) {
        clack.note(info.userCode === undefined ? info.url : `${info.url}\n\nCode: ${info.userCode}`, info.userCode === undefined ? 'Open this page' : 'Open this page and enter the code');
      } else {
        io.stdout.write(`${info.url}\n${info.userCode === undefined ? '' : `Code: ${info.userCode}\n`}`);
      }
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
  return {
    callbacks,
    done(message: string) {
      spinner?.stop('Signed in');
      if (io.isTTY) clack.outro(message);
      else io.stdout.write(`${message}\n`);
    },
    failed() {
      spinner?.stop('Sign-in failed');
    },
  };
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
    // The printed URL is the fallback.
  }
}
