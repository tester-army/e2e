/**
 * The HTTP an OAuth flow is made of: form-encoded POSTs to a token endpoint
 * and the token response every vendor answers with. Timing values from the
 * wire are coerced defensively: a `NaN` expiry written to disk would poison
 * the credentials file.
 */

import { z } from 'zod';
import { OAuthError, describeResponse, type OAuthErrorCode } from './errors.ts';

/**
 * A token response. Vendor-specific fields ride along; an optional token of the
 * wrong type is dropped, and `expires_in` stays raw for `expiryFrom`.
 */
const TokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().optional().catch(undefined),
  id_token: z.string().optional().catch(undefined),
  expires_in: z.unknown().optional(),
});

export type TokenResponse = z.infer<typeof TokenResponseSchema>;

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
  const tokens = parseTokens(await response.json());
  if (tokens === undefined) throw new OAuthError('FLOW_FAILED', `the ${vendor} token response is missing access_token`);
  return tokens;
}

/** The tokens in a token endpoint's JSON body, or undefined when it carries no access token. */
export function parseTokens(body: unknown): TokenResponse | undefined {
  const result = TokenResponseSchema.safeParse(body);
  return result.success ? result.data : undefined;
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
