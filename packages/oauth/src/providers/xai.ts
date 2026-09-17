/**
 * SuperGrok and X Premium+ through xAI's OAuth server. xAI publishes RFC 8628
 * device authorization for the Grok CLI's public client; the token is a plain
 * bearer against the ordinary xAI API. Refresh tokens rotate, so a renewed
 * refresh token replaces the stored one at once.
 */

import { runDeviceFlow } from '../device-code.ts';
import { OAuthError, describeResponse } from '../errors.ts';
import { decodeJwtPayload } from '../pkce.ts';
import type { OAuthLoginCallbacks, OAuthProvider } from '../types.ts';

/** The public OAuth client of the Grok CLI, which third-party harnesses sign in through. */
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_ISSUER = 'https://auth.x.ai';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_SKEW_MS = 120_000;

export interface XaiLoginOptions {
  /** The `referrer` the device request names: your product. */
  readonly referrer?: string;
}

export interface XaiProviderOptions {
  readonly issuer?: string;
  readonly referrer?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export function createXaiProvider(options: XaiProviderOptions = {}): OAuthProvider<XaiLoginOptions> {
  const issuer = options.issuer ?? XAI_ISSUER;
  const referrer = options.referrer ?? 'e2e';
  return {
    id: 'xai',
    name: 'xAI',
    refreshSkewMs: REFRESH_SKEW_MS,
    async login(callbacks, loginOptions = {}) {
      const tokens = await deviceLogin(callbacks, issuer, loginOptions.referrer ?? referrer);
      return toCredentials(tokens, '');
    },
    async refresh(credentials) {
      const response = await fetch(`${issuer}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refresh, client_id: XAI_CLIENT_ID }),
      });
      if (response.status === 400 || response.status === 401) {
        throw new OAuthError('LOGIN_REQUIRED', `xAI rejected the refresh token (${await describeResponse(response)}); sign in again`);
      }
      if (!response.ok) throw new OAuthError('FLOW_FAILED', `xAI token refresh failed: ${await describeResponse(response)}`);
      return toCredentials((await response.json()) as TokenResponse, credentials.refresh);
    },
  };
}

function toCredentials(tokens: TokenResponse, previousRefresh: string) {
  if (typeof tokens.access_token !== 'string') throw new OAuthError('FLOW_FAILED', 'the xAI token response is missing access_token');
  const fromJwt = decodeJwtPayload(tokens.access_token)?.['exp'];
  const expires =
    typeof fromJwt === 'number' && fromJwt > 0 ? fromJwt * 1000 : Date.now() + (tokens.expires_in ?? 3600) * 1000;
  return { access: tokens.access_token, refresh: tokens.refresh_token ?? previousRefresh, expires };
}

async function deviceLogin(callbacks: OAuthLoginCallbacks, issuer: string, referrer: string): Promise<TokenResponse> {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  return runDeviceFlow<TokenResponse>({
    callbacks,
    async start() {
      const response = await fetch(`${issuer}/oauth2/device/code`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ client_id: XAI_CLIENT_ID, scope: SCOPE, referrer }),
      });
      if (!response.ok) throw new OAuthError('FLOW_FAILED', `xAI device login could not start: ${await describeResponse(response)}`);
      const json = (await response.json()) as Record<string, unknown>;
      if (typeof json['device_code'] !== 'string' || typeof json['user_code'] !== 'string' || typeof json['verification_uri'] !== 'string') {
        throw new OAuthError('FLOW_FAILED', 'the xAI device code response is missing fields');
      }
      return {
        deviceCode: json['device_code'],
        userCode: json['user_code'],
        verificationUri: json['verification_uri'],
        ...(typeof json['verification_uri_complete'] === 'string' ? { verificationUriComplete: json['verification_uri_complete'] } : {}),
        expiresIn: Number(json['expires_in']),
        interval: Number(json['interval']),
      };
    },
    async poll(authorization) {
      const response = await fetch(`${issuer}/oauth2/token`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ grant_type: DEVICE_GRANT, client_id: XAI_CLIENT_ID, device_code: authorization.deviceCode }),
      });
      if (response.ok) return { status: 'granted', value: (await response.json()) as TokenResponse };
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      switch (json['error']) {
        case 'authorization_pending':
          return { status: 'pending' };
        case 'slow_down':
          return { status: 'slow_down' };
        case 'access_denied':
        case 'authorization_denied':
          return { status: 'denied' };
        case 'expired_token':
          return { status: 'expired' };
        default:
          throw new OAuthError('FLOW_FAILED', `xAI device login failed: ${String(json['error_description'] ?? json['error'] ?? response.status)}`);
      }
    },
  });
}
