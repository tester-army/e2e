/**
 * Transport: one POST of every event a CLI invocation produced to PostHog's
 * batch endpoint. The key is the project's public, write-only ingestion key,
 * the kind websites embed in their pages; it can add events and nothing else.
 *
 * The request is bounded and quiet. It aborts when the caller's signal does,
 * never retries, and swallows every failure: telemetry that is lost is
 * telemetry, telemetry that delays or fails a command is a bug.
 */

import type { JsonValue } from '../types.ts';

/** The PostHog Cloud EU ingestion host. */
export const POSTHOG_HOST = 'https://eu.i.posthog.com';

/** The e2e project's ingestion key: public and write-only, like the key posthog-js embeds in a page. */
export const POSTHOG_PROJECT_KEY = 'phc_rT8hpREuSj5bRGPHP6KLKNuf4kfwhP4FEf6ahHHV2ZgH';

/** One item of the batch, exactly as PostHog receives it; `distinct_id` is a property. */
export interface PostHogEvent {
  readonly event: string;
  /** RFC 3339. */
  readonly timestamp: string;
  readonly properties: Readonly<Record<string, JsonValue>> & { readonly distinct_id: string };
}

export interface PostBatchOptions {
  /** Aborts the request: the caller's one deadline for everything telemetry does after the command. */
  readonly signal: AbortSignal;
  readonly fetch: typeof fetch;
}

/** Sends the batch; resolves to whether PostHog accepted it. */
export async function postBatch(events: readonly PostHogEvent[], options: PostBatchOptions): Promise<boolean> {
  try {
    const response = await options.fetch(`${POSTHOG_HOST}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: POSTHOG_PROJECT_KEY, batch: events }),
      signal: options.signal,
    });
    return response.ok;
  } catch {
    return false;
  }
}
