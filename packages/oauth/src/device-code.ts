/**
 * RFC 8628 device authorization: the server hands out a user code, the user
 * enters it on any device, and the client polls the token endpoint until the
 * grant lands. `runDeviceFlow` owns the timing for any vendor's shape;
 * `rfc8628Flow` is the standard shape itself, which GitHub and xAI both
 * speak apart from the status code they answer "pending" with.
 */

import { OAuthError, describeResponse } from './errors.ts';
import { positiveSeconds, postForm, type TokenResponse } from './token-endpoint.ts';
import type { OAuthLoginCallbacks } from './types.ts';

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  /** Seconds until the code expires. */
  readonly expiresIn: number;
  /** Seconds between polls. */
  readonly interval: number;
}

export type DevicePoll<T> =
  | { readonly status: 'granted'; readonly value: T }
  | { readonly status: 'pending' }
  /** RFC 8628 §3.5: add five seconds to the interval, or take the interval the server named. */
  | { readonly status: 'slow_down'; readonly intervalSeconds?: number }
  | { readonly status: 'denied' }
  | { readonly status: 'expired' };

export interface DeviceFlowOptions<T> {
  start(): Promise<DeviceAuthorization>;
  poll(authorization: DeviceAuthorization): Promise<DevicePoll<T>>;
  instructions?(authorization: DeviceAuthorization): string;
  readonly callbacks: OAuthLoginCallbacks;
  /** Test seam. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_INTERVAL_S = 5;
const MIN_INTERVAL_MS = 1_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;
const DEFAULT_EXPIRES_S = 15 * 60;

export async function runDeviceFlow<T>(options: DeviceFlowOptions<T>): Promise<T> {
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const { callbacks } = options;
  const authorization = await options.start();
  callbacks.onAuth({
    url: authorization.verificationUriComplete ?? authorization.verificationUri,
    userCode: authorization.userCode,
    instructions:
      options.instructions?.(authorization) ??
      `Open ${authorization.verificationUri} on any device and enter the code ${authorization.userCode}.`,
  });

  const deadline = now() + positiveSeconds(authorization.expiresIn, DEFAULT_EXPIRES_S) * 1000;
  let intervalMs = Math.max(positiveSeconds(authorization.interval, DEFAULT_INTERVAL_S) * 1000, MIN_INTERVAL_MS);
  while (now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())), callbacks.signal);
    const result = await options.poll(authorization);
    switch (result.status) {
      case 'granted':
        return result.value;
      case 'pending':
        continue;
      case 'slow_down':
        intervalMs =
          result.intervalSeconds !== undefined && result.intervalSeconds > 0
            ? result.intervalSeconds * 1000
            : intervalMs + SLOW_DOWN_INCREMENT_MS;
        continue;
      case 'denied':
        throw new OAuthError('CANCELLED', 'the authorization was denied');
      case 'expired':
        throw new OAuthError('TIMEOUT', 'the device code expired before the login finished; run the login again');
    }
  }
  throw new OAuthError('TIMEOUT', 'the device code expired before the login finished; run the login again');
}

export interface Rfc8628Options {
  readonly vendor: string;
  readonly deviceCodeUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  /** The device request's body besides `client_id`: scope, and whatever the vendor adds. */
  readonly request: Record<string, string>;
  readonly callbacks: OAuthLoginCallbacks;
}

/** The standard device flow; the poll reads the body before the status, since vendors disagree on the status for "pending". */
export function rfc8628Flow(options: Rfc8628Options): Promise<TokenResponse> {
  const { vendor, clientId, callbacks } = options;
  return runDeviceFlow<TokenResponse>({
    callbacks,
    async start() {
      const response = await postForm(options.deviceCodeUrl, { client_id: clientId, ...options.request });
      if (!response.ok) throw new OAuthError('FLOW_FAILED', `${vendor} device login could not start: ${await describeResponse(response)}`);
      const json = (await response.json()) as Record<string, unknown>;
      const { device_code, user_code, verification_uri, verification_uri_complete } = json;
      if (typeof device_code !== 'string' || typeof user_code !== 'string' || typeof verification_uri !== 'string') {
        throw new OAuthError('FLOW_FAILED', `the ${vendor} device code response is missing fields`);
      }
      return {
        deviceCode: device_code,
        userCode: user_code,
        verificationUri: verification_uri,
        ...(typeof verification_uri_complete === 'string' ? { verificationUriComplete: verification_uri_complete } : {}),
        expiresIn: Number(json['expires_in']),
        interval: Number(json['interval']),
      };
    },
    async poll(authorization) {
      const response = await postForm(options.tokenUrl, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: authorization.deviceCode,
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof json['access_token'] === 'string') return { status: 'granted', value: json as unknown as TokenResponse };
      switch (json['error']) {
        case 'authorization_pending':
          return { status: 'pending' };
        case 'slow_down':
          return typeof json['interval'] === 'number' ? { status: 'slow_down', intervalSeconds: json['interval'] } : { status: 'slow_down' };
        case 'access_denied':
        case 'authorization_denied':
          return { status: 'denied' };
        case 'expired_token':
          return { status: 'expired' };
        default:
          throw new OAuthError('FLOW_FAILED', `${vendor} device login failed: ${String(json['error_description'] ?? json['error'] ?? response.status)}`);
      }
    },
  });
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OAuthError('CANCELLED', 'the login was cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new OAuthError('CANCELLED', 'the login was cancelled'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
