/**
 * GitHub Copilot. The Copilot API accepts a GitHub OAuth token as the bearer,
 * so the login is GitHub's device flow (RFC 8628) for an OAuth App you
 * register, or the token the GitHub CLI already holds when `gh` is signed in.
 * GitHub user tokens do not expire; a 401 means signing in again.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runDeviceFlow } from '../device-code.ts';
import { OAuthError, describeResponse } from '../errors.ts';
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProvider, PreparedRequest } from '../types.ts';

const execFileAsync = promisify(execFile);

export interface CopilotLoginOptions {
  /**
   * The client id of your GitHub OAuth App with the device flow enabled.
   * Without one, the login reuses the GitHub CLI's token when `gh` is signed in.
   */
  readonly clientId?: string;
  /** Reuse `gh auth token` instead of running a device flow. */
  readonly fromGitHubCli?: boolean;
  /** `github.example.com` for GitHub Enterprise; Copilot then lives at `copilot-api.github.example.com`. */
  readonly enterpriseUrl?: string;
}

export interface CopilotCredentials extends OAuthCredentials {
  readonly enterpriseUrl?: string;
}

export interface CopilotProviderOptions {
  /** Test seam for the device endpoints. */
  readonly githubUrl?: string;
}

function normalizeDomain(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** The Copilot API base for github.com or an enterprise host. */
export function copilotBaseUrl(enterpriseUrl?: string): string {
  return enterpriseUrl === undefined || enterpriseUrl === ''
    ? 'https://api.githubcopilot.com'
    : `https://copilot-api.${normalizeDomain(enterpriseUrl)}`;
}

export function createCopilotProvider(options: CopilotProviderOptions = {}): OAuthProvider<CopilotLoginOptions> {
  return {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    async login(callbacks, loginOptions = {}) {
      const enterprise = loginOptions.enterpriseUrl === undefined ? {} : { enterpriseUrl: normalizeDomain(loginOptions.enterpriseUrl) };
      if (loginOptions.fromGitHubCli === true || loginOptions.clientId === undefined) {
        const token = await githubCliToken(loginOptions.enterpriseUrl);
        if (token !== undefined) {
          callbacks.onProgress?.('Using the GitHub CLI token');
          return { access: token, refresh: '', expires: 0, ...enterprise };
        }
        if (loginOptions.fromGitHubCli === true || loginOptions.clientId === undefined) {
          throw new OAuthError(
            'MISCONFIGURED',
            'GitHub Copilot login needs either the GitHub CLI signed in (gh auth login) or the client id of a GitHub OAuth App with the device flow enabled',
          );
        }
      }
      const clientId = loginOptions.clientId as string;
      const domain = options.githubUrl ?? `https://${normalizeDomain(loginOptions.enterpriseUrl ?? 'github.com')}`;
      const token = await deviceLogin(callbacks, domain, clientId);
      return { access: token, refresh: '', expires: 0, ...enterprise };
    },
    async refresh() {
      throw new OAuthError('LOGIN_REQUIRED', 'GitHub rejected the Copilot token; sign in again');
    },
    prepareRequest(request) {
      return prepareCopilotRequest(request);
    },
  };
}

async function githubCliToken(enterpriseUrl: string | undefined): Promise<string | undefined> {
  const args = ['auth', 'token', ...(enterpriseUrl === undefined ? [] : ['--hostname', normalizeDomain(enterpriseUrl)])];
  try {
    const { stdout } = await execFileAsync('gh', args, { timeout: 10_000 });
    const token = stdout.trim();
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

async function deviceLogin(callbacks: OAuthLoginCallbacks, domain: string, clientId: string): Promise<string> {
  const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
  return runDeviceFlow<string>({
    callbacks,
    async start() {
      const response = await fetch(`${domain}/login/device/code`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ client_id: clientId, scope: 'read:user' }),
      });
      if (!response.ok) throw new OAuthError('FLOW_FAILED', `GitHub device login could not start: ${await describeResponse(response)}`);
      const json = (await response.json()) as Record<string, unknown>;
      if (typeof json['device_code'] !== 'string' || typeof json['user_code'] !== 'string' || typeof json['verification_uri'] !== 'string') {
        throw new OAuthError('FLOW_FAILED', 'the GitHub device code response is missing fields');
      }
      return {
        deviceCode: json['device_code'],
        userCode: json['user_code'],
        verificationUri: json['verification_uri'],
        expiresIn: Number(json['expires_in']),
        interval: Number(json['interval']),
      };
    },
    async poll(authorization) {
      const response = await fetch(`${domain}/login/oauth/access_token`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({
          client_id: clientId,
          device_code: authorization.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      // GitHub answers pending states with 200 and an `error` field.
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof json['access_token'] === 'string') return { status: 'granted', value: json['access_token'] };
      switch (json['error']) {
        case 'authorization_pending':
          return { status: 'pending' };
        case 'slow_down':
          return typeof json['interval'] === 'number' ? { status: 'slow_down', intervalSeconds: json['interval'] } : { status: 'slow_down' };
        case 'access_denied':
          return { status: 'denied' };
        case 'expired_token':
          return { status: 'expired' };
        default:
          throw new OAuthError('FLOW_FAILED', `GitHub device login failed: ${String(json['error_description'] ?? json['error'] ?? response.status)}`);
      }
    },
  });
}

/** Copilot's request headers: who initiated the turn, and that images are present. */
export async function prepareCopilotRequest(request: Request): Promise<PreparedRequest> {
  const headers = new Headers(request.headers);
  headers.set('openai-intent', 'conversation-edits');
  let initiator = 'user';
  let vision = false;
  if (request.method === 'POST') {
    const text = await request.clone().text();
    try {
      const body = JSON.parse(text) as { messages?: Array<{ role?: string; content?: unknown }> };
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const last = messages.at(-1);
      if (last !== undefined && last.role !== 'user') initiator = 'agent';
      vision = messages.some(
        (message) => Array.isArray(message.content) && message.content.some((part: { type?: string }) => part?.type === 'image_url'),
      );
    } catch {
      // Not JSON; the headers stay at their defaults.
    }
  }
  headers.set('x-initiator', initiator);
  if (vision) headers.set('copilot-vision-request', 'true');
  return { request: new Request(request, { headers }) };
}
