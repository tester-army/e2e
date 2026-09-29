/** Kernel's hosted Chromium as a `BrowserProvider` for the web engine. */

import path from 'node:path';
import type {
  BrowserLease,
  BrowserProvider,
  BrowserProviderScope,
  BrowserReleaseContext,
  BrowserRequest,
} from '@e2e-dev/web';
import type { ProviderRecordContext, ProviderRecording } from 'e2e/engine';
import { envValue } from './env.ts';
import { kernelBrowsers, type KernelBrowserParams, type KernelBrowsers, type KernelReplayParams } from './client.ts';

const KERNEL_API_KEY = 'KERNEL_API_KEY';

/**
 * Kernel terminates a browser idle this long: the backstop for a run that
 * died before the engine could release or sweep its leases. Kernel's own
 * default is shorter than a slow suite's gaps between attempts.
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
  /**
   * How an attempt that records video is recorded. On (the default), or
   * Kernel's start-replay body (`framerate`, `max_duration_in_seconds`,
   * `record_audio`): a Kernel replay of the browser's screen, saved as the
   * attempt's `video/replay.mp4`. `false`: the web engine's screencast of
   * the page. A headless browser, which Kernel cannot replay, always gets
   * the screencast.
   */
  readonly replay?: boolean | KernelReplayParams | undefined;
}

const REPLAY_FILE = 'replay.mp4';

/** Where each Kernel browser saves downloads on its own disk, for the engine to read back through the browser filesystem API. */
const DOWNLOADS_DIR = '/tmp/e2e-downloads';

/**
 * Kernel browsers for `web({ browser: kernel() })`: one hosted Chromium per
 * worker slot, or per attempt with `scope: 'attempt'`, created when the
 * engine asks and deleted when it gives the lease back. Every browser is
 * tagged with the run, target, slot, and attempt, and saves downloads to its
 * own disk, read back through Kernel's browser filesystem API.
 * `KERNEL_API_KEY` comes from the run's environment.
 */
export function kernel(options: KernelOptions = {}): BrowserProvider {
  const { scope, replay = true, ...params } = options;
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
  // Kernel replays headful browsers only; without `record` the engine records the screencast.
  const replayParams = replay === false || params.headless === true ? undefined : replay === true ? {} : replay;
  /** Records each attempt as a Kernel replay of the lease's screen, started with `body` and saved as `replay.mp4`. */
  const replays = (body: KernelReplayParams) => async (lease: BrowserLease, context: ProviderRecordContext): Promise<ProviderRecording> => {
    const client = clientFor(context.env);
    const startedAt = new Date().toISOString();
    const replayId = await client.startReplay(lease.id, body, context.signal);
    // A retried stop (the download failed after the replay stopped) downloads again without stopping twice.
    let stopped = false;
    return {
      startedAt,
      async stop({ dir, signal }) {
        if (!stopped) {
          await client.stopReplay(lease.id, replayId, signal);
          stopped = true;
        }
        await client.downloadReplay(lease.id, replayId, path.join(dir, REPLAY_FILE), signal);
        return { file: REPLAY_FILE };
      },
    };
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
    async sweep(context: BrowserReleaseContext): Promise<readonly string[]> {
      const client = clientFor(context.env);
      const open = await client.listActive({ e2e_run: context.runId, e2e_target: context.targetName }, context.signal);
      const settled = await Promise.allSettled(open.map(async (id) => ((await client.delete(id, context.signal)) ? id : undefined)));
      const deleted = settled.flatMap((result) => (result.status === 'fulfilled' && result.value !== undefined ? [result.value] : []));
      const failed = open.flatMap((id, index) => {
        const result = settled[index]!;
        return result.status === 'rejected' ? [`${id} (${result.reason instanceof Error ? result.reason.message : String(result.reason)})`] : [];
      });
      if (failed.length > 0) {
        throw new Error(`deleted ${deleted.length === 0 ? 'none' : deleted.join(', ')}; could not delete ${failed.join(', ')}, so Kernel ends it after timeout_seconds`);
      }
      return deleted;
    },
    downloads: {
      dir: DOWNLOADS_DIR,
      read: async (lease, file, context) => clientFor(context.env).readFile(lease.id, file, context.signal),
    },
    ...(replayParams === undefined ? {} : { record: replays(replayParams) }),
  };
}
