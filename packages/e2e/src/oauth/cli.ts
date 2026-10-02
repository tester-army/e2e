/**
 * The terminal side of a subscription: `runLogin`, `runLogout`, and
 * `runModels` are what `e2e login`, `e2e logout`, and `e2e models` call with
 * the flags commander parsed.
 */

import { spawn } from 'node:child_process';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { sanitizeText } from '../internal/errors.ts';
import { OAuthError } from './errors.ts';
import { login, logout } from './login.ts';
import { listModels } from './models.ts';
import { PROVIDER_IDS, getProvider, isProviderId, type LoginOptionsById, type ProviderId } from './providers.ts';
import { defaultCredentialStore } from './store.ts';
import type { OAuthLoginCallbacks, SubscriptionModel } from './types.ts';

export interface CliIo {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTTY: boolean;
  /** Opens a URL in the user's browser; the default spawns the platform opener. */
  readonly openUrl?: (url: string) => void;
}

/** The `e2e login` flags as commander parses them; each provider reads the ones meant for it. */
export interface LoginFlags {
  readonly device?: boolean;
  readonly clientId?: string;
  readonly fromGh?: boolean;
  readonly enterpriseUrl?: string;
}

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
    say(io, had ? 'success' : 'info', had ? `Signed out of ${getProvider(id).name}.` : `No ${getProvider(id).name} login was stored.`);
  });
}

/**
 * Lists the models `providerId`'s login serves; without one, every stored
 * login in turn, one provider's failure leaving the others listed. One line
 * per model: the id a config passes to the constructor, the vendor's name for
 * it, and what the vendor says about it. Vendor text is untrusted and has its
 * terminal controls stripped. `list` is a test seam.
 */
export async function runModels(providerId: string | undefined, io: CliIo = defaultIo(), list: (id: ProviderId) => Promise<SubscriptionModel[]> = listModels): Promise<number> {
  return report(io, async () => {
    let ids: readonly ProviderId[];
    if (providerId === undefined || providerId === '') {
      ids = [...(await signedIn()).keys()];
      if (ids.length === 0) throw new OAuthError('NOT_LOGGED_IN', `no login is stored; sign in with e2e login <${PROVIDER_IDS.join('|')}>`);
    } else {
      ids = [requireProvider(providerId)];
    }
    let failed = false;
    for (const [index, id] of ids.entries()) {
      if (index > 0) io.stdout.write('\n');
      try {
        printModels(io, id, await list(id));
      } catch (cause) {
        if (ids.length === 1) throw cause;
        failed = true;
        say(io, 'error', `${getProvider(id).name} (${id}): ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return failed ? 1 : 0;
  });
}

function printModels(io: CliIo, id: ProviderId, models: readonly SubscriptionModel[]): void {
  const clean = models.map((model) => ({
    id: sanitizeText(model.id),
    ...(model.name === undefined ? {} : { name: sanitizeText(model.name) }),
    ...(model.detail === undefined ? {} : { detail: sanitizeText(model.detail) }),
  }));
  const count = clean.length === 0 ? 'no models listed' : `${clean.length} model${clean.length === 1 ? '' : 's'}`;
  const heading = `${getProvider(id).name} (${id}): ${count}`;
  io.stdout.write(`${io.isTTY ? pc.bold(heading) : heading}\n`);
  const width = Math.max(0, ...clean.map((model) => model.id.length));
  for (const model of clean) {
    const rest = [model.name, model.detail].filter((part) => part !== undefined && part !== '' && part !== model.id);
    if (rest.length === 0) {
      io.stdout.write(`  ${model.id}\n`);
      continue;
    }
    io.stdout.write(`  ${model.id.padEnd(width)}  ${io.isTTY ? pc.dim(rest.join('  ')) : rest.join('  ')}\n`);
  }
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
  'github-copilot': 'GitHub Copilot: OpenAI, Anthropic, Google, and SpaceXAI models',
  spacexai: 'SuperGrok or X Premium+',
  orcarouter: 'OrcaRouter with a key you paste, or ORCAROUTER_API_KEY',
  'orcarouter-oauth': 'OrcaRouter signed in through the browser',
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

/** One line to the user, styled when there is a terminal. */
function say(io: CliIo, kind: 'success' | 'info' | 'error', message: string): void {
  if (!io.isTTY) {
    (kind === 'error' ? io.stderr : io.stdout).write(`${message}\n`);
    return;
  }
  clack.log[kind](message);
}

/** Runs a command, printing a failure as one line; cancellation exits like an interrupt. */
async function report(io: CliIo, run: () => Promise<number | undefined>): Promise<number> {
  try {
    return (await run()) ?? 0;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof OAuthError && cause.code === 'CANCELLED') {
      if (io.isTTY) clack.cancel(message);
      else io.stderr.write(`${message}\n`);
      return 130;
    }
    say(io, 'error', message);
    return 1;
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
      return (flags.device === true ? { method: 'device' } : {}) as LoginOptionsById[Id];
    case 'github-copilot':
      return {
        ...(flags.clientId === undefined ? {} : { clientId: flags.clientId }),
        ...(flags.fromGh === true ? { fromGitHubCli: true } : {}),
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
