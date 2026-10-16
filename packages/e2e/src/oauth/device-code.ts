/**
 * RFC 8628 device authorization: the server hands out a user code, the user
 * enters it on any device, and the client polls the token endpoint until the
 * grant lands. `runDeviceFlow` owns the timing for any vendor's shape;
 * `rfc8628Flow` is the standard shape itself, which GitHub and SpaceXAI both
 * speak apart from the status code they answer "pending" with.
 */

import { z } from 'zod';
import { OAuthError, describeResponse, readJsonBody } from './errors.ts';
import { parseTokens, positiveSeconds, postForm, type TokenResponse } from './token-endpoint.ts';
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
  start(signal: AbortSignal | undefined): Promise<DeviceAuthorization>;
  poll(authorization: DeviceAuthorization, signal: AbortSignal | undefined): Promise<DevicePoll<T>>;
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
  throwIfCancelled(callbacks.signal);
  let authorization: DeviceAuthorization;
  try {
    authorization = await options.start(callbacks.signal);
  } catch (cause) {
    throwIfCancelled(callbacks.signal);
    throw cause;
  }
  throwIfCancelled(callbacks.signal);
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
    let result: DevicePoll<T>;
    try {
      result = await options.poll(authorization, callbacks.signal);
    } catch (cause) {
      throwIfCancelled(callbacks.signal);
      throw cause;
    }
    // A grant that lands after the user cancelled is not a login.
    throwIfCancelled(callbacks.signal);
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

/** Keeps interrupted device requests and late grants under the login cancellation code. */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OAuthError('CANCELLED', 'the login was cancelled');
}

/** The device authorization response, as far as the flow reads it; the timing values stay raw for `positiveSeconds`. */
const DeviceCodeSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional().catch(undefined),
  expires_in: z.unknown().optional(),
  interval: z.unknown().optional(),
});

/** The error fields of a poll that granted nothing; a field of another type, or a body that is not an object, names nothing. */
const DevicePollErrorSchema = z
  .object({
    error: z.string().optional().catch(undefined),
    error_description: z.string().optional().catch(undefined),
    interval: z.number().optional().catch(undefined),
  })
  .catch({});

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
    async start(signal) {
      const response = await postForm(options.deviceCodeUrl, { client_id: clientId, ...options.request }, signal);
      if (!response.ok) throw new OAuthError('FLOW_FAILED', `${vendor} device login could not start: ${await describeResponse(response)}`);
      const device = await readJsonBody(response, DeviceCodeSchema, `the ${vendor} device code response`, 'is missing fields');
      return {
        deviceCode: device.device_code,
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        ...(device.verification_uri_complete === undefined ? {} : { verificationUriComplete: device.verification_uri_complete }),
        expiresIn: Number(device.expires_in),
        interval: Number(device.interval),
      };
    },
    async poll(authorization, signal) {
      const response = await postForm(
        options.tokenUrl,
        { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: authorization.deviceCode },
        signal,
      );
      const body: unknown = await response.json().catch(() => undefined);
      const tokens = parseTokens(body);
      if (tokens !== undefined) return { status: 'granted', value: tokens };
      const { error, error_description, interval } = DevicePollErrorSchema.parse(body);
      switch (error) {
        case 'authorization_pending':
          return { status: 'pending' };
        case 'slow_down':
          return interval === undefined ? { status: 'slow_down' } : { status: 'slow_down', intervalSeconds: interval };
        case 'access_denied':
        case 'authorization_denied':
          return { status: 'denied' };
        case 'expired_token':
          return { status: 'expired' };
        default:
          throw new OAuthError('FLOW_FAILED', `${vendor} device login failed: ${error_description ?? error ?? response.status}`);
      }
    },
  });
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
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
