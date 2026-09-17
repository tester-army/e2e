/**
 * RFC 8628 device authorization: the server hands out a user code, the user
 * enters it on any device, and the client polls the token endpoint until the
 * grant lands. Vendors differ in URLs, body shape, and how they say
 * "pending", so the flow takes those as functions and owns only the timing.
 */

import { OAuthError } from './errors.ts';
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
    throwIfAborted(callbacks.signal);
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

/** A seconds value from the server, or the default when it is missing or not a positive finite number. */
function positiveSeconds(value: unknown, fallback: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OAuthError('CANCELLED', 'the login was cancelled');
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
