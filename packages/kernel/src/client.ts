/** The slice of the Kernel SDK the provider uses, loaded on first use so a config load never pays for it. */

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Kernel } from '@onkernel/sdk';

/** Kernel's create-browser body, its tags read-only. */
export type KernelBrowserParams = Omit<Kernel.BrowserCreateParams, 'tags'> & {
  readonly tags?: Readonly<Record<string, string>> | undefined;
};

/** Kernel's start-replay body: `framerate`, `max_duration_in_seconds`, `record_audio`. */
export type KernelReplayParams = Kernel.Browsers.ReplayStartParams;

interface KernelBrowser {
  readonly sessionId: string;
  readonly cdpWsUrl: string;
  readonly liveViewUrl?: string | undefined;
}

export interface KernelBrowsers {
  create(params: KernelBrowserParams, signal: AbortSignal): Promise<KernelBrowser>;
  /** Deletes the browser; one Kernel no longer knows counts as deleted. */
  delete(sessionId: string, signal: AbortSignal): Promise<void>;
  /** Starts recording the browser's screen; resolves to the replay id. */
  startReplay(sessionId: string, params: KernelReplayParams, signal: AbortSignal): Promise<string>;
  /** Stops a recording. */
  stopReplay(sessionId: string, replayId: string, signal: AbortSignal): Promise<void>;
  /** Downloads a stopped recording's MP4 to `file`. */
  downloadReplay(sessionId: string, replayId: string, file: string, signal: AbortSignal): Promise<void>;
  /** The bytes of one file on the browser's own disk. */
  readFile(sessionId: string, file: string, signal: AbortSignal): Promise<Uint8Array>;
}

/** Kernel browsers for one API key, through the SDK. */
export function kernelBrowsers(apiKey: string): KernelBrowsers {
  const sdk = import('@onkernel/sdk').then((module) => ({ client: new module.Kernel({ apiKey }), NotFoundError: module.NotFoundError }));
  return {
    async create(params, signal) {
      const { client } = await sdk;
      const created = await client.browsers.create({ ...params, tags: { ...params.tags } }, { signal });
      return { sessionId: created.session_id, cdpWsUrl: created.cdp_ws_url, liveViewUrl: created.browser_live_view_url };
    },
    async delete(sessionId, signal) {
      const { client, NotFoundError } = await sdk;
      try {
        await client.browsers.deleteByID(sessionId, { signal });
      } catch (cause) {
        if (!(cause instanceof NotFoundError)) throw cause;
      }
    },
    async startReplay(sessionId, params, signal) {
      const { client } = await sdk;
      const replay = await client.browsers.replays.start(sessionId, params, { signal });
      return replay.replay_id;
    },
    async stopReplay(sessionId, replayId, signal) {
      const { client } = await sdk;
      await client.browsers.replays.stop(replayId, { id_or_name: sessionId }, { signal });
    },
    async downloadReplay(sessionId, replayId, file, signal) {
      const { client } = await sdk;
      const response = await client.browsers.replays.download(replayId, { id_or_name: sessionId }, { signal });
      if (response.body === null) throw new Error(`replay ${replayId} downloaded empty`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(file), { signal });
    },
    async readFile(sessionId, file, signal) {
      const { client } = await sdk;
      const response = await client.browsers.fs.readFile(sessionId, { path: file }, { signal });
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
