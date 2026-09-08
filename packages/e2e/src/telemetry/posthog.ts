/**
 * Transport: one POST of every event a CLI invocation produced to PostHog's
 * batch endpoint. The key is a project's public, write-only ingestion key,
 * the kind websites embed in their pages; it can add events and nothing else.
 *
 * The request is bounded and quiet. It aborts at the deadline the caller
 * sets, never retries, and swallows every failure: telemetry that is lost is
 * telemetry, telemetry that delays or fails a command is a bug.
 */

import type { JsonValue } from '../types.ts';

/** The PostHog Cloud EU ingestion host. */
export const POSTHOG_HOST = 'https://eu.i.posthog.com';

/**
 * The project's ingestion key. Empty until one is configured; with no key,
 * events are built (and printed under `E2E_TELEMETRY_DEBUG`) but never sent.
 */
export const POSTHOG_PROJECT_KEY = 'phc_rT8hpREuSj5bRGPHP6KLKNuf4kfwhP4FEf6ahHHV2ZgH';

/** One item of the batch, exactly as PostHog receives it; `distinct_id` is a property. */
export interface PostHogEvent {
  readonly event: string;
  /** RFC 3339. */
  readonly timestamp: string;
  readonly properties: Readonly<Record<string, JsonValue>> & { readonly distinct_id: string };
}

export interface PostBatchOptions {
  readonly host: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly fetch: typeof fetch;
}

/** Sends the batch; resolves to whether PostHog accepted it. */
export async function postBatch(events: readonly PostHogEvent[], options: PostBatchOptions): Promise<boolean> {
  if (events.length === 0 || options.apiKey === '') return false;
  try {
    const response = await options.fetch(`${options.host}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: options.apiKey, batch: events }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}
