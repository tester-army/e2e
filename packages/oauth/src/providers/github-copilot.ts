/**
 * GitHub Copilot. The Copilot API accepts a GitHub sign-in as the bearer, so
 * the login is either the token the GitHub CLI already holds or GitHub's
 * device flow (RFC 8628) for an OAuth App you register. GitHub user tokens do
 * not expire; a 401 means signing in again.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rfc8628Flow } from '../device-code.ts';
import { OAuthError } from '../errors.ts';
import type { FetchFunction, OAuthCredentials, OAuthProvider } from '../types.ts';

const execFileAsync = promisify(execFile);

export interface CopilotLoginOptions {
  /**
   * The client id of your GitHub OAuth App with the device flow enabled.
   * Without one, the login reuses the GitHub CLI's token when `gh` is signed in.
   */
  readonly clientId?: string;
  /** Reuse `gh auth token` even when a client id is given. */
  readonly fromGitHubCli?: boolean;
  /** `github.example.com` for GitHub Enterprise; Copilot then lives at `copilot-api.github.example.com`. */
  readonly enterpriseUrl?: string;
}

export interface CopilotCredentials extends OAuthCredentials {
  readonly enterpriseUrl?: string;
}

export interface CopilotProviderOptions {
  /** Test seams: the GitHub host the device flow talks to, and how the GitHub CLI's token is read. */
  readonly githubUrl?: string;
  readonly githubCliToken?: (hostname: string | undefined) => Promise<string | undefined>;
}

export const COPILOT_API_URL = 'https://api.githubcopilot.com';

function normalizeDomain(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** The Copilot API base for github.com or an enterprise host. */
export function copilotBaseUrl(enterpriseUrl?: string): string {
  return enterpriseUrl === undefined || enterpriseUrl === '' ? COPILOT_API_URL : `https://copilot-api.${normalizeDomain(enterpriseUrl)}`;
}

export function createCopilotProvider(options: CopilotProviderOptions = {}): OAuthProvider<CopilotCredentials, CopilotLoginOptions> {
  const cliToken = options.githubCliToken ?? githubCliToken;
  return {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    async login(callbacks, loginOptions = {}) {
      const enterprise = loginOptions.enterpriseUrl === undefined ? undefined : normalizeDomain(loginOptions.enterpriseUrl);
      const stored = enterprise === undefined ? {} : { enterpriseUrl: enterprise };
      if (loginOptions.clientId !== undefined && loginOptions.fromGitHubCli !== true) {
        const tokens = await rfc8628Flow({
          vendor: 'GitHub',
          deviceCodeUrl: `${options.githubUrl ?? `https://${enterprise ?? 'github.com'}`}/login/device/code`,
          tokenUrl: `${options.githubUrl ?? `https://${enterprise ?? 'github.com'}`}/login/oauth/access_token`,
          clientId: loginOptions.clientId,
          request: { scope: 'read:user' },
          callbacks,
        });
        return { access: tokens.access_token, refresh: '', expires: 0, ...stored };
      }
      const token = await cliToken(enterprise);
      if (token === undefined) {
        throw new OAuthError(
          'MISCONFIGURED',
          'GitHub Copilot login needs either the GitHub CLI signed in (gh auth login) or the client id of a GitHub OAuth App with the device flow enabled',
        );
      }
      callbacks.onProgress?.('Using the GitHub CLI token');
      return { access: token, refresh: '', expires: 0, ...stored };
    },
    async refresh() {
      throw new OAuthError('LOGIN_REQUIRED', 'GitHub rejected the Copilot token; sign in again');
    },
    send(request, credentials, upstream) {
      return sendCopilotRequest(request, credentials, upstream);
    },
  };
}

async function githubCliToken(hostname: string | undefined): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token', ...(hostname === undefined ? [] : ['--hostname', hostname])], { timeout: 10_000 });
    return stdout.trim() === '' ? undefined : stdout.trim();
  } catch {
    return undefined;
  }
}

/** Routes an enterprise login at its host and adds Copilot's headers: who initiated the turn, and that images are present. */
export async function sendCopilotRequest(request: Request, credentials: CopilotCredentials, upstream: FetchFunction): Promise<Response> {
  const url = new URL(request.url);
  if (credentials.enterpriseUrl !== undefined && url.origin === COPILOT_API_URL) url.host = new URL(copilotBaseUrl(credentials.enterpriseUrl)).host;
  const headers = new Headers(request.headers);
  headers.set('openai-intent', 'conversation-edits');
  let initiator = 'user';
  let vision = false;
  const text = request.method === 'POST' ? await request.text() : undefined;
  if (text !== undefined) {
    try {
      const body = JSON.parse(text) as { messages?: Array<{ role?: string; content?: unknown }> };
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (messages.at(-1)?.role !== 'user') initiator = 'agent';
      vision = messages.some(
        (message) => Array.isArray(message.content) && message.content.some((part: { type?: string }) => part?.type === 'image_url'),
      );
    } catch {
      // Not JSON; the headers stay at their defaults.
    }
  }
  headers.set('x-initiator', initiator);
  if (vision) headers.set('copilot-vision-request', 'true');
  return upstream(new Request(url, { method: request.method, headers, signal: request.signal, ...(text === undefined ? {} : { body: text }) }));
}
