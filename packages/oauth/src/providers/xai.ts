/**
 * SuperGrok and X Premium+ through xAI's OAuth server. xAI publishes RFC 8628
 * device authorization for the Grok CLI's public client; the token is a plain
 * bearer against the ordinary xAI API. Refresh tokens rotate, so a renewed
 * refresh token replaces the stored one at once.
 */

import { rfc8628Flow } from '../device-code.ts';
import { decodeJwtPayload } from '../jwt.ts';
import { expiryFrom, requestTokens, type TokenResponse } from '../token-endpoint.ts';
import type { OAuthCredentials, OAuthProvider } from '../types.ts';

/** The public OAuth client of the Grok CLI, which third-party harnesses sign in through. */
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const ISSUER = 'https://auth.x.ai';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';

export interface XaiProviderOptions {
  /** The `referrer` the device request names: your product. */
  readonly referrer?: string;
  /** Test seam. */
  readonly issuer?: string;
}

export function createXaiProvider(options: XaiProviderOptions = {}): OAuthProvider<OAuthCredentials, Record<string, never>> {
  const issuer = options.issuer ?? ISSUER;
  const referrer = options.referrer ?? 'e2e';
  return {
    id: 'xai',
    name: 'xAI',
    async login(callbacks) {
      const tokens = await rfc8628Flow({
        vendor: 'xAI',
        deviceCodeUrl: `${issuer}/oauth2/device/code`,
        tokenUrl: `${issuer}/oauth2/token`,
        clientId: CLIENT_ID,
        request: { scope: SCOPE, referrer },
        callbacks,
      });
      return toCredentials(tokens, '');
    },
    async refresh(credentials) {
      const tokens = await requestTokens(
        'xAI',
        `${issuer}/oauth2/token`,
        { grant_type: 'refresh_token', refresh_token: credentials.refresh, client_id: CLIENT_ID },
        'LOGIN_REQUIRED',
      );
      return toCredentials(tokens, credentials.refresh);
    },
  };
}

/** Expiry from the JWT when it carries one, else from `expires_in`; a refresh without a new refresh token keeps the old one. */
function toCredentials(tokens: TokenResponse, previousRefresh: string): OAuthCredentials {
  const exp = decodeJwtPayload(tokens.access_token)?.['exp'];
  const expires = typeof exp === 'number' && exp > 0 ? exp * 1000 : expiryFrom(tokens.expires_in);
  return { access: tokens.access_token, refresh: tokens.refresh_token ?? previousRefresh, expires };
}
