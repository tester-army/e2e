/**
 * The HTTP an OAuth flow is made of: form-encoded POSTs to a token endpoint
 * and the token response every vendor answers with. Timing values from the
 * wire are coerced defensively: a `NaN` expiry written to disk would poison
 * the credentials file.
 */

import { OAuthError, describeResponse, type OAuthErrorCode } from './errors.ts';

export interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly expires_in?: number;
}

export async function postForm(url: string, params: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params),
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * Posts a grant and returns the tokens. A 400 or 401 means the grant itself
 * was rejected and maps to `rejected` (LOGIN_REQUIRED for a refresh, FLOW_FAILED
 * for a code exchange); anything else not OK is FLOW_FAILED. The message names
 * the failure only; the fetch that called for the refresh appends the remedy.
 */
export async function requestTokens(
  vendor: string,
  url: string,
  params: Record<string, string>,
  rejected: OAuthErrorCode = 'FLOW_FAILED',
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const response = await postForm(url, params, signal);
  if (!response.ok) {
    const code = response.status === 400 || response.status === 401 ? rejected : 'FLOW_FAILED';
    throw new OAuthError(code, `${vendor} token request failed (${await describeResponse(response)})`);
  }
  const tokens = (await response.json()) as Partial<TokenResponse>;
  if (typeof tokens.access_token !== 'string' || tokens.access_token === '') {
    throw new OAuthError('FLOW_FAILED', `the ${vendor} token response is missing access_token`);
  }
  return tokens as TokenResponse;
}

/** A seconds value from the server, or the default when it is missing or not a positive finite number. */
export function positiveSeconds(value: unknown, fallback: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

/** When a token expires, from `expires_in`; one hour when the server names nothing usable. */
export function expiryFrom(expiresIn: unknown, now: number = Date.now()): number {
  const expiry = now + positiveSeconds(expiresIn, 3600) * 1000;
  return Number.isFinite(expiry) ? expiry : now + 3600 * 1000;
}
