/** Kernel's hosted Chromium as a `BrowserProvider` for the web engine. */

import type { BrowserLease, BrowserProvider, BrowserProviderScope, BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { envValue } from '../env.ts';
import { kernelBrowsers, type KernelBrowserParams, type KernelBrowsers } from './client.ts';

const KERNEL_API_KEY = 'KERNEL_API_KEY';

/**
 * Kernel terminates a browser idle this long: the backstop for a worker that
 * died before the engine could release its lease. Kernel's own default is
 * shorter than a slow suite's gaps between attempts.
 */
const DEFAULT_TIMEOUT_SECONDS = 600;

/**
 * Kernel's create-browser body (`stealth`, `headless`, `timeout_seconds`,
 * `profile`, `proxy_id`, `viewport`, `tags`, ...) plus the lease scope the
 * web engine defines.
 */
export interface KernelOptions extends KernelBrowserParams {
  /**
   * `worker` (default): one browser per worker slot, leased in `prepare` and
   * released in `finish`. `attempt`: a fresh browser per test attempt,
   * reattached after a CDP transport drop; rules out `headers` and `basicAuth`.
   */
  readonly scope?: BrowserProviderScope | undefined;
}

/**
 * Kernel browsers for `web({ browser: kernel() })`: one hosted Chromium per
 * worker slot, or per attempt with `scope: 'attempt'`, created when the
 * engine asks and deleted when it gives the lease back. Every browser is
 * tagged with the run, target, slot, and attempt. `KERNEL_API_KEY` comes
 * from the run's environment.
 */
export function kernel(options: KernelOptions = {}): BrowserProvider {
  const { scope, ...params } = options;
  const clients = new Map<string, KernelBrowsers>();
  const clientFor = (env: BrowserRequest['env']): KernelBrowsers => {
    const apiKey = envValue(env, KERNEL_API_KEY);
    if (apiKey === undefined) throw new Error(`${KERNEL_API_KEY} is not set`);
    let client = clients.get(apiKey);
    if (client === undefined) {
      client = kernelBrowsers(apiKey);
      clients.set(apiKey, client);
    }
    return client;
  };
  return {
    name: 'kernel',
    ...(scope === undefined ? {} : { scope }),
    async acquire(request: BrowserRequest): Promise<BrowserLease> {
      const client = clientFor(request.env);
      const browser = await client.create(
        {
          timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
          ...params,
          tags: {
            ...params.tags,
            e2e_run: request.runId,
            e2e_target: request.targetName,
            e2e_slot: String(request.slot),
            ...(request.attemptId === undefined ? {} : { e2e_attempt: request.attemptId }),
          },
        },
        request.signal,
      );
      if (request.signal.aborted) {
        const outcome = await client.delete(browser.sessionId, AbortSignal.timeout(10_000)).then(
          () => 'deleted',
          (cause: unknown) => `deleting it failed, so Kernel ends it after timeout_seconds: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        throw new Error(`browser ${browser.sessionId} arrived after the request was cancelled; ${outcome}`);
      }
      request.log(browser.liveViewUrl === undefined ? `browser ${browser.sessionId}` : `browser ${browser.sessionId}, watch at ${browser.liveViewUrl}`);
      return { id: browser.sessionId, cdpEndpoint: browser.cdpWsUrl };
    },
    async release(lease: BrowserLease, context: BrowserReleaseContext): Promise<void> {
      await clientFor(context.env).delete(lease.id, context.signal);
    },
  };
}
